// lib/core.mjs —— 入库、检索、分块版本、记忆状态机
//
// 检索融合用加权 RRF（WeKnora 04-rag-pipeline.md:496）+ MMR 去冗余（:231，λ=0.7）。
// 因为没有向量库，RRF 只在"多个查询变体"之间融合；单变体时退化为单路排序。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb, nowIso, getMeta, setMeta } from './db.mjs';
import { splitDoc } from './chunk.mjs';
import { tokenizeSync, tokenizeQuery, segmentWords } from './tokenize.mjs';
import { append as journalAppend } from './journal.mjs';
import { recallScenes } from './scenes.mjs';
import { embedQuery, searchVectors, touchVectorVersion } from './vector.mjs';
import { moduleSummaries, moduleKeyOf, invalidateModuleCache } from './modules.mjs';
import { effectiveTerms, distinctiveTerms, isKnowledgeQuestion, invalidateDfCache } from './terms.mjs';

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.log', '.csv', '.json', '.yaml', '.yml']);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const norm = (s) => s.replace(/\r\n/g, '\n');

// ---------------- 入库 ----------------
export function ingestFolder(db, rootAbs, opts = {}) {
  // 入库改变了 df 与总量口径，词频缓存必须失效，否则后续查询的"判别力"判断失真
  try { invalidateDfCache(); } catch { /* 缓存模块缺失不影响入库 */ }
  const cfg = {
    chunk_size: opts.chunk_size ?? 512,
    chunk_overlap: opts.chunk_overlap ?? 80,
    strategy: opts.strategy ?? 'auto',
  };
  const exts = opts.exts ? new Set(opts.exts) : TEXT_EXT;
  const maxFiles = opts.max_files ?? 5000;

  const stats = { scanned: 0, imported: 0, skipped: 0, failed: 0, chunks: 0, tiers: {}, errors: [] };
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (stats.scanned >= maxFiles) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (/^(node_modules|\.git|dist|build|__pycache__|\.venv)$/i.test(e.name)) continue;
        walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      if (!exts.has(path.extname(e.name).toLowerCase())) continue;
      stats.scanned++;
      try {
        const rel = (opts.prefix ? opts.prefix.replace(/\/+$/, '') + '/' : '')
          + path.relative(rootAbs, abs).split(path.sep).join('/');
        const buf = fs.readFileSync(abs);
        const hash = sha256(buf);
        const st = fs.statSync(abs);
        const prev = db.prepare('SELECT id, sha256 FROM documents WHERE rel_path=?').get(rel);
        if (prev && prev.sha256 === hash) { stats.skipped++; continue; }

        const text = norm(buf.toString('utf8'));
        const { chunks, tier } = splitDoc(text, cfg);
        if (!chunks.length) { stats.failed++; stats.errors.push({ rel, error: 'no chunks' }); continue; }

        db.exec('BEGIN');
        try {
          let docId;
          if (prev) {
            docId = prev.id;
            db.prepare('DELETE FROM chunks_fts_tokens WHERE rowid IN (SELECT id FROM chunks WHERE doc_id=?)').run(docId);
            db.prepare('DELETE FROM chunks WHERE doc_id=?').run(docId);
            touchVectorVersion(db);   // 块被删，向量也随之删除，必须让其它进程感知
            db.prepare('UPDATE documents SET size=?,mtime=?,sha256=?,imported_at=? WHERE id=?')
              .run(st.size, st.mtime.toISOString(), hash, nowIso(), docId);
          } else {
            const r = db.prepare('INSERT INTO documents(rel_path,abs_path,size,mtime,sha256,imported_at) VALUES(?,?,?,?,?,?)')
              .run(rel, abs, st.size, st.mtime.toISOString(), hash, nowIso());
            docId = Number(r.lastInsertRowid);
          }
          const insChunk = db.prepare('INSERT INTO chunks(doc_id,ordinal,heading,context_header,text,tier,version,tokens) VALUES(?,?,?,?,?,?,1,?)');
          const insTok = db.prepare('INSERT INTO chunks_fts_tokens(rowid, tokens) VALUES(?,?)');
          const insVer = db.prepare('INSERT INTO chunk_versions(chunk_id,version,text,heading,editor,note,created_at) VALUES(?,1,?,?,?,?,?)');
          for (const c of chunks) {
            const toks = tokenizeSync((c.context_header ? c.context_header + '\n' : '') + c.text);
            const r = insChunk.run(docId, c.ordinal, c.heading, c.context_header, c.text, c.tier, toks);
            const cid = Number(r.lastInsertRowid);
            insTok.run(cid, toks);
            insVer.run(cid, c.text, c.heading, 'ingest', 'initial', nowIso());
          }
          db.exec('COMMIT');
          stats.imported++;
          stats.chunks += chunks.length;
          stats.tiers[tier] = (stats.tiers[tier] || 0) + 1;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      } catch (err) {
        stats.failed++;
        stats.errors.push({ rel: path.relative(rootAbs, abs), error: String(err.message || err) });
      }
    }
  };
  walk(rootAbs);
  setMeta(db, 'last_ingest_at', nowIso());
  return stats;
}

// ---------------- 检索 ----------------
// 中文没有空格，trigram 只吃"精确子串"，召回过窄。
// 所以拆词：ASCII 词按词切，中文按二元组切，两条路一起召回再融合。

function queryTerms(q) {
  const s = q.trim();
  const out = new Set();
  for (const m of s.matchAll(/[A-Za-z0-9_.-]{2,}/g)) out.add(m[0].toLowerCase());
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) out.add(run);
    else for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

function ftsQuery(db, q, limit) {
  const s = q.trim();
  const terms = queryTerms(s).filter((t) => [...t].length >= 3 || /[a-z]/i.test(t));
  if (!terms.length) return [];
  const expr = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  try {
    return db.prepare(`
      SELECT c.id, c.doc_id, c.ordinal, c.text, c.heading, c.context_header, d.rel_path
      FROM chunks_fts f JOIN chunks c ON c.id=f.rowid JOIN documents d ON d.id=c.doc_id
      WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`).all(expr, limit);
  } catch {
    return [];
  }
}

function tokenQuery(db, q, limit) {
  const terms = tokenizeQuery(q).slice(0, 16);
  if (!terms.length) return [];
  const expr = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  try {
    return db.prepare(`
      SELECT c.id, c.doc_id, c.ordinal, c.text, c.heading, c.context_header, d.rel_path
      FROM chunks_fts_tokens f JOIN chunks c ON c.id=f.rowid JOIN documents d ON d.id=c.doc_id
      WHERE chunks_fts_tokens MATCH ? ORDER BY rank LIMIT ?`).all(expr, limit);
  } catch {
    return [];
  }
}

/** 回填/重建 token 索引（老数据没有 tokens 时用） */
export function reindexTokens(db, { batch = 500, force = false } = {}) {
  const rows = force
    ? db.prepare('SELECT id, context_header, text FROM chunks').all()
    : db.prepare(`
        SELECT c.id, c.context_header, c.text FROM chunks c
        LEFT JOIN chunks_fts_tokens t ON t.rowid = c.id
        WHERE c.tokens IS NULL OR t.rowid IS NULL`).all();
  let done = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    db.exec('BEGIN');
    try {
      const upd = db.prepare('UPDATE chunks SET tokens=? WHERE id=?');
      const del = db.prepare('DELETE FROM chunks_fts_tokens WHERE rowid=?');
      const ins = db.prepare('INSERT INTO chunks_fts_tokens(rowid, tokens) VALUES(?,?)');
      for (const r of slice) {
        const toks = tokenizeSync((r.context_header ? r.context_header + '\n' : '') + r.text);
        upd.run(toks, r.id);
        del.run(r.id);
        ins.run(r.id, toks);
        done++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return { total: rows.length, done };
}

function likeQuery(db, q, limit) {
  const terms = queryTerms(q).slice(0, 12);
  if (!terms.length) return [];
  const where = terms.map(() => '(c.text LIKE ? OR c.heading LIKE ?)').join(' OR ');
  const args = [];
  for (const t of terms) { args.push(`%${t}%`, `%${t}%`); }
  const rows = db.prepare(`
    SELECT c.id, c.doc_id, c.ordinal, c.text, c.heading, c.context_header, d.rel_path
    FROM chunks c JOIN documents d ON d.id=c.doc_id
    WHERE ${where} LIMIT ?`).all(...args, limit * 4);
  // 打分：命中词数，标题权重更高
  const scored = rows.map((r) => {
    let hit = 0;
    const text = r.text || '';
    const head = r.heading || '';
    for (const t of terms) {
      if (head.includes(t)) hit += 2;
      else if (text.includes(t)) hit += 1;
    }
    return { ...r, hits: hit };
  }).filter((r) => r.hits > 0).sort((a, b) => b.hits - a.hits);
  return scored.slice(0, limit);
}

const toTrigrams = (s) => {
  const set = new Set();
  const t = s.toLowerCase().replace(/\s+/g, ' ');
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
};
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

/** 双路召回 + 加权 RRF 融合 + MMR 多样性 */
// ---- 启发式重排（路线 C）----
// 交叉编码器太重、LLM 太慢，先用规则修掉最常见的错序：
// 索引页/汇总页压过具体实现、测试报告压过规格说明、标题命中被忽略。
const GENERIC_DOC = /(README|INDEX|SUMMARY|CHANGELOG|TOC|目录|索引|汇总|总览)/i;
const NOISY_DOC = /(测试|压测|scan_data|ai_prompt|埋点|审计报告|review|_stress|stress_)/i;
const SPEC_DOC = /(\/Spec\/|spec\.md|实现方案|设计|规格)/i;

function heuristicFactor(row, terms, query) {
  let f = 1;
  const path = String(row.rel_path || '');
  const head = String(row.heading || '').toLowerCase();
  const text = String(row.text || '');
  for (const t of terms) if (head.includes(String(t).toLowerCase())) f += 0.08;
  if (GENERIC_DOC.test(path)) f -= 0.30;
  if (NOISY_DOC.test(path)) f -= 0.12;
  if (SPEC_DOC.test(path)) f += 0.08;
  // 标识符精确命中（大小写敏感）：NpcCreateConfig、BattleCmd 这类词，模糊匹配不可靠
  for (const id of (query.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [])) {
    if (text.includes(id)) f += 0.06;
  }
  return Math.max(0.5, Math.min(1.5, f));
}

export function searchChunks(db, { query, variants = [], limit = 8, k = 60, mmrLambda = 0.7, pool = 60, extraLists = [], heuristic = true } = {}) {
  const all = [query, ...variants.filter(Boolean)];
  // 每类召回给不同权重：词元 BM25 最准，trigram 次之，向量补充语义，LIKE 只做兜底
  const W = { token: 1.0, trigram: 0.9, vector: 0.6, like: 0.35 };
  const lists = [];
  const push = (rows, weight, kind) => { if (rows.length) lists.push({ rows, weight, kind }); };
  for (const q of all) {
    const tk = tokenQuery(db, q, pool);
    const f = ftsQuery(db, q, pool);
    // 有词元/子串命中时，LIKE 只作补充（权重低）；全空才当主力
    push(tk, W.token, 'token');
    push(f, W.trigram, 'trigram');
    if (!tk.length && !f.length) {
      const l = likeQuery(db, q, pool);
      if (l.length) lists.push({ rows: l, weight: W.like + 0.5, kind: 'like' });
    }
  }
  if (!lists.length && !extraLists.length) return { results: [], usedQueries: all, fused: 0 };
  // 向量路（异步算好再传进来）：和其它路一样参与 RRF，按名次融合
  for (const l of extraLists) {
    if (l && Array.isArray(l.rows) && l.rows.length) {
      lists.push({ rows: l.rows, weight: l.weight ?? W.vector, kind: l.kind || 'vector' });
    }
  }
  if (!lists.length) return { results: [], usedQueries: all, fused: 0 };

  const scores = new Map();
  const meta = new Map();
  const hitLists = new Map();
  for (const { rows, weight } of lists) {
    rows.forEach((row, idx) => {
      const s = weight / (k + idx + 1);
      scores.set(row.id, (scores.get(row.id) || 0) + s);
      hitLists.set(row.id, (hitLists.get(row.id) || 0) + 1);
      if (!meta.has(row.id)) meta.set(row.id, row);
    });
  }
  // 归一化：按"所有列表都排第一"的理论上限，而不是单个列表
  const maxPossible = lists.reduce((a, l) => a + l.weight / (k + 1), 0);
  let raw = [...scores.entries()]
    .map(([id, s]) => {
      const m = meta.get(id);
      return { ...m, score: Math.min(1, s / maxPossible), hits: hitLists.get(id) };
    })
    .sort((a, b) => b.score - a.score || b.hits - a.hits);

  // min-max 拉伸：RRF 的绝对分差异很小，不拉伸的话 MMR 的冗余项会盖过相关度
  const lo = raw.length ? raw[raw.length - 1].score : 0;
  const hi = raw.length ? raw[0].score : 0;
  const span = hi - lo;
  let cands = raw.map((c) => ({
    ...c,
    score: span > 1e-9 ? 0.35 + 0.65 * ((c.score - lo) / span) : c.score,
  }));

  // 启发式重排：调整分数后重排，再进 MMR
  if (heuristic) {
    const hTerms = segmentWords(query).filter((t) => t.length >= 2).slice(0, 10);
    if (hTerms.length) {
      cands = cands
        .map((c) => ({ ...c, score: Number((c.score * heuristicFactor(c, hTerms, query)).toFixed(4)) }))
        .sort((a, b) => b.score - a.score || b.hits - a.hits);
    }
  }

  // MMR
  const picked = [];
  const pool_ = cands.slice(0, pool);
  while (picked.length < limit && pool_.length) {
    let best = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < pool_.length; i++) {
      const c = pool_[i];
      let red = 0;
      for (const p of picked) red = Math.max(red, jaccard(toTrigrams(c.text), toTrigrams(p.text)));
      const val = mmrLambda * c.score - (1 - mmrLambda) * red;
      if (val > bestVal) { bestVal = val; best = i; }
    }
    const chosen = pool_.splice(best, 1)[0];
    picked.push({ ...chosen, mmr: Number(bestVal.toFixed(4)) });
  }
  // 给每条结果挂上所属模块的一句话摘要：注入和工具返回都能据此判断"要不要展开"
  try {
    const mods = moduleSummaries(db);
    if (mods.size) {
      for (const r of picked) {
        const summary = mods.get(moduleKeyOf(r.rel_path));
        if (summary) r.module = summary;
      }
    }
  } catch { /* 模块表还没建就跳过 */ }
  return { results: picked, usedQueries: all, fused: cands.length };
}

/**
 * 知识库召回：给自动注入用。
 * 和 recall() 分开，是因为两者的预算、评分口径都不同：记忆要"常驻 + 匹配"，
 * 知识库只按相关度取前几块，且必须显示来源路径，方便模型判断可信度。
 */
export function recallKb(db, query, { limit = 2, minScore = 0.25, extraRows = [] } = {}) {
  try {
    const q = String(query || '').trim();
    if (q.length < 4) return [];
    // 操作指令（"把v1-v4删掉"）不查知识库：文档库回答的是"怎么运作"，不是"帮我删除"
    if (!isKnowledgeQuestion(q)) return [];
    // 用"有效词"而不是整句：整句进 FTS 会被虚词带偏，召出一堆无关块
    const terms = distinctiveTerms(db, q);
    if (terms.length < 2) return [];
    const r = searchChunks(db, { query: terms.join(' '), limit: Math.max(limit * 6, 12) });
    // 长标识符（NpcCreateConfig 这类）本身就是强信号，命中一个就够
    const hasIdentifier = terms.some((t) => /^[A-Za-z][A-Za-z0-9_]{5,}$/i.test(t));
    const need = hasIdentifier ? 1 : Math.max(2, Math.ceil(terms.length * 0.5));
    const hits = (r.results || [])
      .map((x) => {
        const hay = String(x.text || '').toLowerCase();
        const cover = terms.filter((t) => hay.includes(t.toLowerCase())).length;
        return { x, cover };
      })
      // 词覆盖率闸门：只命中一个虚词就召回来的块（"今天""功能"这类）直接丢弃
      .filter(({ cover }) => cover >= need)
      .filter(({ x }) => Number(x.score) >= minScore);

    // 按文档聚合：一篇文档命中多块，说明它整体更相关；
    // 比单块分数可靠——长文档靠边角内容也能刷出高分。
    const byDoc = new Map();
    for (const h of hits) {
      const p = h.x.rel_path;
      const cur = byDoc.get(p);
      if (!cur) {
        byDoc.set(p, { path: p, docScore: h.cover, best: h });
      } else {
        cur.docScore += h.cover;
        if (h.cover > cur.best.cover || (h.cover === cur.best.cover && Number(h.x.score) > Number(cur.best.x.score))) {
          cur.best = h;
        }
      }
    }
    const out = [...byDoc.values()]
      .sort((a, b) => b.docScore - a.docScore || Number(b.best.x.score) - Number(a.best.x.score))
      .slice(0, limit)
      .map(({ best }) => ({
        chunk_id: best.x.id, path: best.x.rel_path, ordinal: best.x.ordinal,
        score: Number(Number(best.x.score).toFixed(3)), text: String(best.x.text || ''),
        module: best.x.module || null,
      }));

    // 向量补充：词面招不到（同义改写）时，用向量结果补位，去重后仍不超过 limit
    for (const row of extraRows || []) {
      if (out.length >= limit) break;
      if (out.some((o) => o.chunk_id === row.id)) continue;
      out.push({
        chunk_id: row.id, path: row.rel_path, ordinal: row.ordinal,
        score: Number(Number(row.vscore || 0).toFixed(3)), text: String(row.text || ''),
        module: row.module || null, via: 'vector',
      });
    }
    return out;
  } catch { return []; }
}

/**
 * 注入用的知识库召回（带向量补充）。
 * 词面为主、向量补位：只在词面命中不足 limit 时才用向量填。
 */
export async function recallKbAsync(db, query, { limit = 2, minScore = 0.25, vectorEnabled = null } = {}) {
  const enabled = vectorEnabled ?? (getMeta(db, 'vector_enabled') === '1');
  let extraRows = [];
  if (enabled && String(query || '').trim().length >= 4) {
    try {
      const qv = await embedQuery(query);
      // 相似度下限 0.50：实测相关查询落在 0.52~0.61，无关查询 0.43~0.47。
      // 不设下限的话，"今天天气不错"这种也会被向量塞进两块无关文档。
      const floor = Number(process.env.MEM_KB_VECTOR_FLOOR || 0.5);
      if (qv) extraRows = searchVectors(db, qv, { limit: 6 }).filter((r) => (r.vscore || 0) >= floor);
    } catch { /* 模型不可用就只走词面 */ }
  }
  return recallKb(db, query, { limit, minScore, extraRows });
}

/** 混合检索：词面三路 + 向量一路。向量未启用或不可用时自动退回纯词面。 */
export async function searchChunksHybrid(db, opts = {}) {
  const { query, vectorWeight = 0.6, pool = 60 } = opts;
  const enabled = opts.vectorEnabled ?? (getMeta(db, 'vector_enabled') === '1');
  if (!enabled || !query || !String(query).trim()) return searchChunks(db, opts);
  try {
    const qvec = await embedQuery(query);
    if (!qvec) return searchChunks(db, opts);
    const rows = searchVectors(db, qvec, { limit: pool });
    if (!rows.length) return searchChunks(db, opts);
    return searchChunks(db, { ...opts, extraLists: [{ rows, weight: vectorWeight, kind: 'vector' }] });
  } catch {
    // 模型加载失败等：绝不阻断检索
    return searchChunks(db, opts);
  }
}

/**
 * 交互式检索：混合召回 + LLM 重排。
 * 只给 kb_search / CLI / Web 用——自动注入走 searchChunksHybrid（毫秒级）。
 */
export async function searchInteractive(db, opts = {}) {
  const base = await searchChunksHybrid(db, opts);
  if (opts.rerank === false) return base;
  const { llmRerank, llmRerankEnabled } = await import('./rerank.mjs');
  if (!llmRerankEnabled()) return base;
  const reranked = await llmRerank(opts.query, base.results, {
    topN: Number(process.env.MEM_RERANK_TOPN || 12),
    timeoutMs: Number(process.env.MEM_RERANK_TIMEOUT_MS || 8000),
  });
  return { ...base, results: reranked };
}

export function getChunk(db, id) {
  return db.prepare(`
    SELECT c.*, d.rel_path FROM chunks c JOIN documents d ON d.id=c.doc_id WHERE c.id=?`).get(id);
}

// ---------------- 分块版本 ----------------
export function editChunk(db, chunkId, newText, { editor = 'user', note = '', baseVersion = null } = {}) {
  const c = db.prepare('SELECT * FROM chunks WHERE id=?').get(chunkId);
  if (!c) throw new Error(`chunk ${chunkId} not found`);
  if (baseVersion != null && c.version !== baseVersion) {
    throw new Error(`version conflict: current=${c.version}, base=${baseVersion}（请重新读取后再提交）`);
  }
  const v = c.version + 1;
  const toks = tokenizeSync((c.context_header ? c.context_header + '\n' : '') + newText);
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO chunk_versions(chunk_id,version,text,heading,editor,note,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(chunkId, v, newText, c.heading, editor, note, nowIso());
    db.prepare('UPDATE chunks SET text=?,version=?,edited_at=?,edited_by=?,tokens=? WHERE id=?')
      .run(newText, v, nowIso(), editor, toks, chunkId);
    db.prepare('DELETE FROM chunks_fts_tokens WHERE rowid=?').run(chunkId);
    db.prepare('INSERT INTO chunks_fts_tokens(rowid, tokens) VALUES(?,?)').run(chunkId, toks);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  touchVectorVersion(db);   // 正文变了，旧向量已被触发器删除，通知其它进程
  return { chunkId, version: v };
}

export function chunkHistory(db, chunkId) {
  return db.prepare('SELECT version,editor,note,created_at,length(text) AS chars FROM chunk_versions WHERE chunk_id=? ORDER BY version DESC')
    .all(chunkId);
}

export function chunkVersionText(db, chunkId, version) {
  const r = db.prepare('SELECT text,heading,created_at FROM chunk_versions WHERE chunk_id=? AND version=?').get(chunkId, version);
  return r || null;
}

export function rollbackChunk(db, chunkId, toVersion, { editor = 'user' } = {}) {
  const old = chunkVersionText(db, chunkId, toVersion);
  if (!old) throw new Error(`version ${toVersion} not found`);
  return editChunk(db, chunkId, old.text, { editor, note: `rollback to v${toVersion}` });
}

/** 逐字符 diff（LCS 简化版：行级 + 字符级摘要） */
export function diffTexts(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  const n = al.length, m = bl.length;
  if (n * m > 4_000_000) return { mode: 'too-large', note: '文本过大，跳过逐行对齐', added: m, removed: n };
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) { out.push({ op: ' ', line: al[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: '-', line: al[i] }); i++; }
    else { out.push({ op: '+', line: bl[j] }); j++; }
  }
  while (i < n) out.push({ op: '-', line: al[i++] });
  while (j < m) out.push({ op: '+', line: bl[j++] });
  return { mode: 'line', hunks: out };
}

// ---------------- 目录树 ----------------
export function tree(db) {
  const rows = db.prepare(`
    SELECT d.rel_path, COUNT(c.id) AS chunks, d.id
    FROM documents d LEFT JOIN chunks c ON c.doc_id=d.id GROUP BY d.id ORDER BY d.rel_path`).all();
  const root = { name: '', dirs: new Map(), files: [] };
  for (const r of rows) {
    const parts = r.rel_path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push({ name: parts[parts.length - 1], path: r.rel_path, chunks: r.chunks, docId: r.id });
  }
  const render = (n, depth) => {
    const lines = [];
    for (const d of [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`${'  '.repeat(depth)}${d.name}/`);
      lines.push(...render(d, depth + 1));
    }
    for (const f of n.files.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`${'  '.repeat(depth)}${f.name}  (${f.chunks} chunks)`);
    }
    return lines;
  };
  return render(root, 0).join('\n');
}

// ---------------- 记忆 ----------------
const KINDS = new Set(['profile', 'preference', 'fact', 'todo', 'interest']);
const STANDING = ['profile', 'preference', 'interest'];

// 判定"同一主题"的阈值：subject 相同即视为同题；否则看文本相似度
const SUPERSEDE_THRESHOLD = 0.5;

/**
 * 找同主题的旧记忆。
 * 对齐 WeKnora 的语义：新推断**不立刻**顶掉旧条目，只在确认时替换
 * （23-memory.md:25「确认前旧条目继续生效，确认时一并替换」）。
 */
export function findConflict(db, { kind, subject = '', text, excludeId = null }) {
  const rows = db.prepare(`SELECT * FROM memories WHERE kind=? AND status IN ('pending','active')`).all(kind);
  const tri = toTrigrams(text || '');
  let best = null;
  for (const r of rows) {
    if (excludeId && r.id === excludeId) continue;
    const sameSubject = !!(subject && r.subject && subject.trim() === r.subject.trim());
    const sim = jaccard(tri, toTrigrams(r.text));
    if (sameSubject || sim >= SUPERSEDE_THRESHOLD) {
      if (!best || sim > best.sim) best = { row: r, sim: Number(sim.toFixed(3)), sameSubject };
    }
  }
  return best;
}

export function remember(db, { kind, text, subject = '', status = 'pending', confidence = 0.6, source = '', tags = '', supersedes = null, detail = null }) {
  if (!KINDS.has(kind)) throw new Error(`kind 必须是 ${[...KINDS].join('/')}`);
  if (!text || !text.trim()) throw new Error('text 不能为空');
  const body = text.trim();
  // 显式指定优先；否则自动探测同主题旧条目（只挂链接，不改旧条目状态）
  let sup = supersedes ? Number(supersedes) : null;
  let autoSim = null;
  if (!sup) {
    const c = findConflict(db, { kind, subject, text: body });
    if (c) { sup = c.row.id; autoSim = c.sim; }
  }
  const r = db.prepare(`INSERT INTO memories(kind,subject,text,status,confidence,source,tags,created_at,confirmed_at,supersedes_id,detail)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(kind, subject, body, status, confidence, source, tags, nowIso(),
    status === 'active' ? nowIso() : null, sup, detail);
  const id = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO memory_versions(memory_id,version,text,editor,note,created_at) VALUES(?,1,?,?,?,?)')
    .run(id, body, 'agent', 'created', nowIso());
  journalAppend({
    op: 'put', id, kind, subject, text: body, status, confidence, source, tags,
    created_at: nowIso(), supersedes_id: sup, detail, version: 1,
  });
  return { id, status, supersedes: sup, similarity: autoSim };
}

export function confirmMemory(db, id, { editor = 'user' } = {}) {
  const m = db.prepare('SELECT * FROM memories WHERE id=?').get(id);
  if (!m) throw new Error(`memory ${id} not found`);
  let replaced = null;
  db.exec('BEGIN');
  try {
    if (m.supersedes_id) {
      const old = db.prepare('SELECT id,status FROM memories WHERE id=?').get(m.supersedes_id);
      if (old && old.status !== 'rejected' && old.status !== 'superseded') {
        db.prepare("UPDATE memories SET status='superseded', superseded_by=? WHERE id=?").run(id, m.supersedes_id);
        replaced = m.supersedes_id;
      }
    }
    db.prepare('UPDATE memories SET status=?, confirmed_at=? WHERE id=?').run('active', nowIso(), id);
    db.exec('COMMIT');
    if (replaced) journalAppend({ op: 'status', id: replaced, status: 'superseded', superseded_by: id });
    journalAppend({ op: 'status', id, status: 'active', confirmed_at: nowIso() });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { id, status: 'active', replaced };
}

export function rejectMemory(db, id, { note = '' } = {}) {
  const m = db.prepare('SELECT * FROM memories WHERE id=?').get(id);
  if (!m) throw new Error(`memory ${id} not found`);
  // 拒绝留抑制记录：status=rejected，保留正文供后续去重
  // 版本号必须同步推进：否则下一次 edit 会重复使用同一个 (id, version)，撞唯一约束
  const v = (m.version || 1) + 1;
  db.prepare('UPDATE memories SET status=?, version=? WHERE id=?').run('rejected', v, id);
  db.prepare('INSERT INTO memory_versions(memory_id,version,text,editor,note,created_at) VALUES(?,?,?,?,?,?)')
    .run(id, v, m.text, 'user', note || 'rejected', nowIso());
  journalAppend({ op: 'status', id, status: 'rejected', version: v, note: note || '' });
  return { id, status: 'rejected' };
}

export function editMemory(db, id, newText, { editor = 'user', note = '' } = {}) {
  const m = db.prepare('SELECT * FROM memories WHERE id=?').get(id);
  if (!m) throw new Error(`memory ${id} not found`);
  const v = (m.version || 1) + 1;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE memories SET text=?, version=?, status=? WHERE id=?').run(newText, v, m.status === 'pending' ? 'active' : m.status, id);
    db.prepare('INSERT INTO memory_versions(memory_id,version,text,editor,note,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, v, newText, editor, note || 'edited', nowIso());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  journalAppend({ op: 'edit', id, text: newText, version: v, status: m.status === 'pending' ? 'active' : m.status, note: note || 'edited' });
  return { id, version: v };
}

export function listMemories(db, { status = null, kind = null, limit = 100 } = {}) {
  let sql = 'SELECT * FROM memories WHERE 1=1';
  const args = [];
  if (status) { sql += ' AND status=?'; args.push(status); }
  if (kind) { sql += ' AND kind=?'; args.push(kind); }
  sql += ' ORDER BY id DESC LIMIT ?';
  args.push(limit);
  return db.prepare(sql).all(...args);
}

/**
 * 召回：常驻类（profile/preference/interest）+ 按问匹配（fact/todo）
 * pending 一律不注入（WeKnora 23-memory.md:25）
 *
 * 两道质量控制（否则"你好，今天继续"这类低信息量输入会把噪声顶到预算里）：
 *   1. 停用词表：寒暄/虚词/万能词不参与匹配
 *   2. 有效词下限：有效词少于 minTerms 时只给常驻，不做匹配召回
 */

const kindRank = (k) => (k === 'preference' || k === 'profile' ? 2 : k === 'todo' ? 1 : 0);

export function recall(db, query = '', { budgetChars = 1200, withScenes = true, minTerms = 2, intentQuery = null } = {}) {
  // intentQuery：本轮自己的用户消息。场景闸门必须用它判断，
  // 否则上一轮的提问会让本轮的"把v1删掉"通过闸门，带出无关场景。
  const sceneQuery = intentQuery || query;
  const out = [];
  let used = 0;

  // 近重复去重：库里积了大量改写变体（8 条"兼容旧代码"、4 条"版本号 0.6.0"），
  // 不去重的话预算全被同一件事的多种说法吃光，真正相关的条目挤不进来。
  const seenToks = [];
  const toksOf = (s) => new Set(segmentWords(s).map((w) => w.toLowerCase()).filter((w) => w.length >= 2));
  const isDup = (text) => {
    const t = toksOf(text);
    if (!t.size) return false;
    for (const s of seenToks) {
      let inter = 0;
      for (const x of t) if (s.has(x)) inter++;
      if (inter / Math.min(t.size, s.size) >= 0.65) return true;
    }
    return false;
  };
  const push = (m, reason) => {
    if (isDup(m.text)) return false;
    seenToks.push(toksOf(m.text));
    out.push({ ...m, reason });
    used += m.text.length;
    return true;
  };

  const standing = db.prepare(`SELECT * FROM memories WHERE status='active' AND kind IN ('profile','preference','interest') ORDER BY confirmed_at DESC LIMIT 50`).all();
  // 近重复里让"更长更具体"的变体先活下来，而不是随机按时间最早的那条
  standing.sort((a, b) => (b.text.length * (b.confidence || 0)) - (a.text.length * (a.confidence || 0)));
  // 常驻层先攒着：匹配层更相关，应该占用前面的名额
  const terms = query.trim() ? effectiveTerms(query) : [];
  // 有效词不足 → 只给常驻，宁可少给也不要给噪声
  if (terms.length >= minTerms) {
    // 全量载入活跃记忆再打分。
    // 原来在 SQL 侧按词过滤 + LIMIT 600：常用词（开发/使用/工作）会把前 600 行占满，
    // 后面真正相关的那条永远进不了候选池（实测 #638「UI功能开发必须优先使用 ui-create」被挡）。
    // 活跃记忆是千级规模，全量扫描比错误过滤更划算。
    const total = db.prepare("SELECT COUNT(*) n FROM memories WHERE status='active'").get().n;
    const poolRows = total <= 20000
      ? db.prepare("SELECT * FROM memories WHERE status='active'").all()
      : db.prepare(`SELECT * FROM memories WHERE status='active' AND (${terms.map(() => '(text LIKE ? OR subject LIKE ? OR detail LIKE ?)').join(' OR ')}) LIMIT 20000`).all(...terms.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]));
    const scored = poolRows.map((m) => {
      const head = (m.text + ' ' + (m.subject || '')).toLowerCase();
      const full = head + ' ' + String(m.detail || '').toLowerCase();
      let hit = 0;
      for (const term of terms) {
        const t = term.toLowerCase();
        if (head.includes(t)) hit += 2;      // 标题命中权重更高
        else if (full.includes(t)) hit += 1; // 正文命中
      }
      return { m, hit };
    }).filter((x) => x.hit > 0 && x.m.kind !== 'profile').sort((a, b) =>
        // 偏好/画像优先于事实：问"该怎么做"时规则比实现细节更重要
        (kindRank(b.m.kind) - kindRank(a.m.kind)) ||
        (b.hit - a.hit) || (b.m.confidence - a.m.confidence));
    for (const { m } of scored) {
      // 放不下就跳过继续试后面的（原来 break，一条长条目能让整层什么都不给）
      if (used + m.text.length > budgetChars) continue;
      // 常驻层已经给过的、或与已注入内容近重复的，跳过
      if (out.some((x) => x.id === m.id)) continue;
      if (!push(m, 'matched')) continue;
    }
  }

  // 匹配层用完名额后，再用常驻层补位（身份/偏好兜底）。
  // 之前常驻在前，把"UI 功能开发必须优先用 ui-create"这类查询相关偏好挤到了第 7 位之外。
  for (const m of standing) {
    if (used + m.text.length > budgetChars) continue;
    if (out.some((x) => x.id === m.id)) continue;
    push(m, 'standing');
  }
  return { items: out, chars: used, terms: terms.length, scenes: withScenes && terms.length ? recallScenes(db, sceneQuery, { limit: 2 }) : [] };
}

export { KINDS, openDb };