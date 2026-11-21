#!/usr/bin/env node
// cli.mjs —— 命令行入口（人用 / 脚本用），所有输出为 JSON 或纯文本
import { openDb } from './lib/db.mjs';
import {
  ingestFolder, searchChunks, searchChunksHybrid, searchInteractive, getChunk, editChunk, chunkHistory,
  chunkVersionText, rollbackChunk, diffTexts, tree,
  remember, confirmMemory, rejectMemory, editMemory, listMemories, recall, findConflict,
  reindexTokens,
} from './lib/core.mjs';
import { runAutoExtract, recentTurns, llmDistill, isHarnessNoise, shouldAutoAdmit, dedupePendingMemories } from './lib/extract.mjs';
import { probe as llmProbe } from './lib/llm.mjs';
import { importLegacy } from './lib/import-legacy.mjs';
import { warmup as warmupTokenizer, tokenizerState, segmentWords } from './lib/tokenize.mjs';
import * as journal from './lib/journal.mjs';
import { recordUsage, setRecorder, usageSummary } from './lib/usage.mjs';
import { clusterMemories, buildScene, listScenes, getScene } from './lib/scenes.mjs';
import { buildProfile, getProfileBlock, profileNeedsRefresh } from './lib/profile.mjs';
import { buildVectors, vectorStats } from './lib/vector.mjs';
import { buildModuleIndex, listModules } from './lib/modules.mjs';
import { mergeDuplicateActive, restoreMerge } from './lib/merge.mjs';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { ROOT as rootDir, nowIso, setMeta } from './lib/db.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

function flag(name, def = null) {
  const i = rest.indexOf('--' + name);
  if (i < 0) return def;
  return rest[i + 1];
}
const has = (name) => rest.includes('--' + name);
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

const db = openDb();
setRecorder((r) => recordUsage(db, r));

// 只有需要分词的命令才加载 jieba（5MB 词典，按需付代价）
if (['ingest', 'search', 'reindex-tokens', 'edit', 'rollback', 'distill', 'dedupe-pending',
     'admit-pending', 'merge-active', 'recall', 'scenes-cluster', 'scenes-build', 'module-index-build'].includes(cmd)) {
  const st = await warmupTokenizer();
  if (st.state === 'failed') {
    process.stderr.write(`[warn] jieba 不可用（${st.error}），检索退化为二元组\n`);
  }
}

try {
  switch (cmd) {
    case 'kb-clear': {
      // 只清知识库（documents/chunks），不动记忆。备份的是元数据，正文可从原目录重新入库。
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const docs = db.prepare(`SELECT d.rel_path, d.abs_path, d.size, d.sha256, d.imported_at,
        (SELECT COUNT(*) FROM chunks c WHERE c.doc_id=d.id) AS chunks FROM documents d`).all();
      const chunkTotal = db.prepare('SELECT COUNT(*) n FROM chunks').get().n;
      const backupPath = join(rootDir, `kb-backup-${stamp}.json`);
      writeFileSync(backupPath, JSON.stringify({ at: new Date().toISOString(), documents: docs, chunks: chunkTotal }, null, 2), 'utf8');
      if (has('dry')) { out({ dry: true, documents: docs.length, chunks: chunkTotal, backup: backupPath }); break; }
      db.exec('BEGIN');
      try {
        // chunks_fts_tokens 是手工维护的 FTS 表，没有删除触发器，必须显式清空；
        // 否则残留 rowid 会让新入库撞主键（constraint failed）。
        for (const r of db.prepare('SELECT rowid FROM chunks_fts_tokens').all()) {
          db.prepare('DELETE FROM chunks_fts_tokens WHERE rowid=?').run(r.rowid);
        }
        db.prepare('DELETE FROM chunks').run();
        db.prepare('DELETE FROM documents').run();
        // 模块索引是知识库的派生数据，清库必须一起清，否则留下指向已删文档的旧摘要
        try { db.prepare('DELETE FROM module_index').run(); } catch { /* 表可能还不存在 */ }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      out({ cleared: docs.length, chunks: chunkTotal, backup: backupPath });
      break;
    }
    case 'ingest': {
      const dir = positional[0];
      if (!dir) throw new Error('用法: cli.mjs ingest <目录> [--size 512] [--overlap 80] [--strategy auto] [--prefix 名称]');
      const stats = ingestFolder(db, dir, {
        chunk_size: Number(flag('size', 512)),
        chunk_overlap: Number(flag('overlap', 80)),
        strategy: flag('strategy', 'auto'),
        max_files: Number(flag('max', 5000)),
        prefix: flag('prefix', '') || undefined,
      });
      out(stats);
      break;
    }
    case 'tree':
      process.stdout.write(tree(db) + '\n');
      break;
    case 'search': {
      const q = positional[0];
      if (!q) throw new Error('用法: cli.mjs search <query> [--variants "a|b"] [--limit 8]');
      const variants = (flag('variants', '') || '').split('|').map((s) => s.trim()).filter(Boolean);
      const r = await searchInteractive(db, { query: q, variants, limit: Number(flag('limit', 8)) });
      out({
        usedQueries: r.usedQueries, fused: r.fused,
        results: r.results.map((x) => ({
          id: x.id, path: x.rel_path, ordinal: x.ordinal,
          score: Number(x.score.toFixed(4)), mmr: x.mmr,
          heading: x.heading, text: x.text.slice(0, 160),
          module: x.module || null,
        })),
      });
      break;
    }
    case 'get': {
      const id = Number(positional[0]);
      const c = getChunk(db, id);
      if (!c) throw new Error('未找到');
      out(c);
      break;
    }
    case 'edit': {
      const id = Number(positional[0]);
      const text = positional[1];
      if (!text) throw new Error('用法: cli.mjs edit <chunkId> <新文本> [--note "..."] [--base N]');
      out(editChunk(db, id, text, {
        note: flag('note', ''),
        baseVersion: flag('base') ? Number(flag('base')) : null,
      }));
      break;
    }
    case 'history': {
      out(chunkHistory(db, Number(positional[0])));
      break;
    }
    case 'diff': {
      const id = Number(positional[0]);
      const a = Number(flag('from', 1));
      const b = Number(flag('to'));
      const va = chunkVersionText(db, id, a);
      const vb = b ? chunkVersionText(db, id, b) : getChunk(db, id);
      if (!va || !vb) throw new Error('版本不存在');
      out({ chunkId: id, from: a, to: b, diff: diffTexts(va.text, vb.text) });
      break;
    }
    case 'rollback': {
      out(rollbackChunk(db, Number(positional[0]), Number(positional[1])));
      break;
    }
    case 'remember': {
      out(remember(db, {
        kind: flag('kind', 'fact'),
        text: positional[0] || flag('text', ''),
        subject: flag('subject', ''),
        status: flag('status', 'pending'),
        confidence: Number(flag('conf', 0.6)),
        source: flag('source', 'cli'),
        tags: flag('tags', ''),
        supersedes: flag('supersedes', null),
      }));
      break;
    }
    case 'extract': {
      const r = runAutoExtract(db, {
        sessionsDir: flag('sessions', undefined),
        limit: Number(flag('limit', 30)),
        dryRun: has('dry'),
        maxFiles: Number(flag('maxfiles', 50)),
      });
      out(r);
      break;
    }
    case 'probe-llm': out(await llmProbe()); break;
    case 'import-legacy':
    case 'import-lingshu': {
      out(importLegacy(db, {
        dryRun: has('dry'),
        limit: Number(flag('limit', 5000)),
        dir: flag('dir', undefined) || undefined,
      }));
      break;
    }
    case 'distill': {
      const turns = recentTurns(flag('sessions', undefined), Number(flag('turns', 60)));
      const r = await llmDistill(db, {
        turns,
        limit: Number(flag('limit', 30)),
        dryRun: has('dry'),
      });
      out(r);
      break;
    }
    case 'merge-active': {
      out(mergeDuplicateActive(db, {
        threshold: Number(flag('threshold', 0.65)),
        dryRun: has('dry'),
      }));
      break;
    }
    case 'restore-merge': {
      out(restoreMerge(db, positional[0] || flag('file', '')));
      break;
    }
    case 'module-index-build': {
      const r = await buildModuleIndex(db, {
        batch: Number(flag('batch', 8)),
        limit: Number(flag('limit', 0)),
        onProgress: (d, t) => process.stderr.write(`\r  ${d}/${t}   `),
      });
      process.stderr.write('\n');
      out(r);
      break;
    }
    case 'module-index-list': out(listModules(db, { limit: Number(flag('limit', 200)) })); break;
    case 'vector-status': out(vectorStats(db)); break;
    case 'vector-build': {
      const limit = Number(flag('limit', 0));
      const t0 = Date.now();
      const r = await buildVectors(db, {
        limit,
        onProgress: (d, t) => process.stderr.write(`\r  ${d}/${t} (${Math.round(d / ((Date.now() - t0) / 1000))} 条/秒)   `),
      });
      process.stderr.write('\n');
      out({ ...r, seconds: Math.round((Date.now() - t0) / 1000) });
      break;
    }
    case 'vector-on': setMeta(db, 'vector_enabled', '1'); out({ vector_enabled: 1 }); break;
    case 'vector-off': setMeta(db, 'vector_enabled', '0'); out({ vector_enabled: 0 }); break;
    case 'scenes-cluster': {
      const cs = clusterMemories(db, {
        minSize: Number(flag('min', 3)),
        minWeight: Number(flag('weight', 3)),
        maxClusters: Number(flag('max', 30)),
      });
      out(cs.map((c) => ({ key: c.key, label: c.label, size: c.members.length, sample: c.members[0]?.text.slice(0, 50) })));
      break;
    }
    case 'scenes-build': {
      const max = Number(flag('max', 5));
      const dry = has('dry');
      const cs = clusterMemories(db, {
        minSize: Number(flag('min', 3)),
        minWeight: Number(flag('weight', 3)),
        maxClusters: max,
      });
      const done = [];
      for (const c of cs.slice(0, max)) {
        try {
          const s = await buildScene(db, c, { dryRun: dry });
          done.push({ key: s.key, title: s.title, count: s.count, dryRun: dry });
        } catch (e) {
          done.push({ key: c.key, error: String(e.message || e).slice(0, 120) });
        }
      }
      out(done);
      break;
    }
    case 'cleanup': {
      const rule = flag('rule', 'process');
      const dry = has('dry');
      const RULES = {
        // 过程日志类：做了什么任务的流水账，对"长期记忆"价值低
        process: ["cat:task_summary_experience", "cat:history_task_reference_files"],
        // 全部历史导入（含项目知识），慎用
        'all-imported': null,
        // 只删正文过短的
        short: 'short',
        // 元配置噪声：我会话里把开关调成了什么，对后续会话无价值
        'meta-config': 'noise',
      };
      if (!(rule in RULES)) throw new Error(`未知规则 ${rule}，可选：${Object.keys(RULES).join(' / ')}`);
      const all = db.prepare("SELECT id, source, tags, text, length(detail) dlen FROM memories WHERE status IN ('active','pending')").all();
      let targets;
      if (rule === 'all-imported') targets = all.filter((m) => String(m.source).startsWith('lingshu:'));
      else if (rule === 'short') targets = all.filter((m) => (m.dlen || 0) < 300 && String(m.source).startsWith('lingshu:'));
      else if (rule === 'meta-config') targets = all.filter((m) => isHarnessNoise(m.text));
      else targets = all.filter((m) => RULES[rule].some((c) => String(m.tags).includes(c)));

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      let backupPath = null;
      if (!dry) {
        // 只有真正执行才留备份；干跑不产生副产物
        backupPath = join(rootDir, `cleanup-${rule}-${stamp}.json`);
        writeFileSync(backupPath, JSON.stringify({
          rule, at: new Date().toISOString(), count: targets.length,
          ids: targets.map((m) => m.id),
          samples: targets.slice(0, 20).map((m) => ({ id: m.id, text: m.text })),
        }, null, 2), 'utf8');
      }

      if (!dry) {
        const upd = db.prepare("UPDATE memories SET status='rejected' WHERE id=?");
        for (const m of targets) {
          upd.run(m.id);
          journal.append({ op: 'status', id: m.id, status: 'rejected', note: 'cleanup:' + rule });
        }
      }
      out({ rule, matched: targets.length, changed: dry ? 0 : targets.length, dry, backup: backupPath });
      break;
    }
    case 'restore-cleanup': {
      const file = positional[0];
      if (!file) throw new Error('用法: cli.mjs restore-cleanup <备份文件名>');
      const p = join(rootDir, file);
      const data = JSON.parse(readFileSync(p, 'utf8'));
      const upd = db.prepare("UPDATE memories SET status='active' WHERE id=? AND status='rejected'");
      let n = 0;
      for (const id of data.ids || []) { upd.run(id); n++; journal.append({ op: 'status', id, status: 'active', note: 'restore-cleanup' }); }
      out({ restored: n, from: p });
      break;
    }
    case 'profile-build': {
      out(await buildProfile(db, { dryRun: has('dry'), maxChars: Number(flag('chars', 300)) }));
      break;
    }
    case 'profile-show': {
      const p = getProfileBlock(db);
      out({ ...p, needsRefresh: profileNeedsRefresh(db) });
      break;
    }
    case 'scenes-list': out(listScenes(db, { limit: Number(flag('limit', 50)) })); break;
    case 'scene': {
      const s = getScene(db, Number(positional[0]));
      out(s || { error: 'not found' });
      break;
    }
    case 'usage': out(usageSummary(db, { days: Number(flag('days', 30)), purpose: flag('purpose', null) })); break;
    case 'journal-stats': out(journal.stats()); break;
    case 'journal-seed': {
      const rows = db.prepare('SELECT * FROM memories ORDER BY id').all();
      for (const m of rows) {
        journal.append({
          op: 'put', id: m.id, kind: m.kind, subject: m.subject, text: m.text,
          status: m.status, confidence: m.confidence, source: m.source, tags: m.tags,
          created_at: m.created_at, confirmed_at: m.confirmed_at,
          supersedes_id: m.supersedes_id, superseded_by: m.superseded_by,
          detail: m.detail, version: m.version,
        });
      }
      out({ seeded: rows.length, journal: journal.stats() });
      break;
    }
    case 'rebuild': out(journal.rebuild(db, { dryRun: has('dry') })); break;
    case 'reindex-tokens': {
      out({ ...reindexTokens(db, { force: has('force') }), tokenizer: tokenizerState() });
      break;
    }
    case 'confirm': out(confirmMemory(db, Number(positional[0]))); break;
    case 'reject': out(rejectMemory(db, Number(positional[0]), { note: flag('note', '') })); break;
    // 批量处理：不想逐条点的时候用
    case 'confirm-all': {
      const rows = db.prepare("SELECT id FROM memories WHERE status='pending' ORDER BY id DESC LIMIT ?").all(Number(flag('limit', 500)));
      let n = 0;
      for (const r of rows) { try { confirmMemory(db, r.id); n++; } catch { /* 单条失败跳过 */ } }
      out({ confirmed: n, total: rows.length });
      break;
    }
    case 'reject-all': {
      const rows = db.prepare("SELECT id FROM memories WHERE status='pending' ORDER BY id DESC LIMIT ?").all(Number(flag('limit', 500)));
      let n = 0;
      for (const r of rows) { try { rejectMemory(db, r.id, { note: flag('note', 'bulk') }); n++; } catch { /* 跳过 */ } }
      out({ rejected: n, total: rows.length });
      break;
    }
    // 把 pending 里的近重复合并掉：保留置信度最高的那条，其余自动拒绝
    case 'dedupe-pending': {
      out(dedupePendingMemories(db, { threshold: Number(flag('threshold', 0.8)) }));
      break;
    }
    // 用新准入规则重审现有 pending：够格的直接转正
    case 'admit-pending': {
      const rows = db.prepare("SELECT id, kind, text, confidence, supersedes_id, tags, subject FROM memories WHERE status='pending'").all();
      const upd = db.prepare("UPDATE memories SET status='active', confirmed_at=?, tags=? WHERE id=?");
      // 用词级包含度判重（字符三元组对改写不敏感，"版本号保持 0.6.0" 的两种说法相似度只有 0.6）
      const { segmentWords } = await import('./lib/tokenize.mjs');
      const toks = (x) => new Set(segmentWords(x).map((w) => w.toLowerCase()).filter((w) => w.length >= 2));
      const activeRows = db.prepare("SELECT id, kind, text FROM memories WHERE status='active'").all()
        .map((a) => ({ id: a.id, kind: a.kind, t: toks(a.text) }));
      let n = 0, dup = 0;
      for (const r of rows) {
        const rt = toks(r.text);
        let bestSim = 0, bestId = 0;
        for (const a of activeRows) {
          if (a.kind !== r.kind) continue;
          let inter = 0;
          for (const x of rt) if (a.t.has(x)) inter++;
          const sim = inter / Math.min(rt.size, a.t.size);
          if (sim > bestSim) { bestSim = sim; bestId = a.id; }
        }
        if (bestSim >= 0.75) {
          rejectMemory(db, r.id, { note: 'dup of active #' + bestId });
          dup++;
          continue;
        }
        if (!shouldAutoAdmit({ kind: r.kind, text: r.text, confidence: r.confidence, supersedes: r.supersedes_id ?? null })) continue;
        upd.run(nowIso(), (r.tags || 'auto') + ',auto-admitted', r.id);
        journal.append({ op: 'status', id: r.id, status: 'active', note: 'admit-pending' });
        n++;
      }
      out({ admitted: n, droppedDuplicate: dup, remaining: rows.length - n - dup, total: rows.length });
      break;
    }
    // 自动入库的审计与撤销
    case 'auto-admitted': {
      const rows = db.prepare(`SELECT id, kind, substr(text,1,60) t, confidence, created_at FROM memories
        WHERE status='active' AND tags LIKE '%auto-admitted%' ORDER BY id DESC LIMIT ?`).all(Number(flag('limit', 30)));
      out(rows);
      break;
    }
    case 'revoke-auto': {
      const rows = db.prepare("SELECT id FROM memories WHERE status='active' AND tags LIKE '%auto-admitted%'").all();
      const upd = db.prepare("UPDATE memories SET status='pending', confirmed_at=NULL WHERE id=?");
      let n = 0;
      for (const r of rows) { upd.run(r.id); journal.append({ op: 'status', id: r.id, status: 'pending', note: 'revoke-auto' }); n++; }
      out({ revoked: n });
      break;
    }
    case 'mem-edit': out(editMemory(db, Number(positional[0]), positional[1], { note: flag('note', '') })); break;
    case 'memories': out(listMemories(db, { status: flag('status'), kind: flag('kind'), limit: Number(flag('limit', 100)) })); break;
    case 'recall': {
      const r = recall(db, positional[0] || '', { budgetChars: Number(flag('budget', 1200)) });
      out(r);
      break;
    }
    case 'stats': {
      const docs = db.prepare('SELECT COUNT(*) n FROM documents').get().n;
      const chunks = db.prepare('SELECT COUNT(*) n FROM chunks').get().n;
      const vers = db.prepare('SELECT COUNT(*) n FROM chunk_versions').get().n;
      const mems = db.prepare('SELECT status, COUNT(*) n FROM memories GROUP BY status').all();
      const tiers = db.prepare('SELECT tier, COUNT(*) n FROM chunks GROUP BY tier').all();
      out({ docs, chunks, versions: vers, memories: mems, tiers });
      break;
    }
    default:
      process.stdout.write(`用法:
  ingest <目录>              入库并分块
  tree                       目录树
  search <query>             检索
  get <chunkId>              读分块
  edit <chunkId> <文本>      编辑分块（生成新版本）
  history <chunkId>          版本历史
  diff <chunkId> --from 1 --to 2   版本比对
  rollback <chunkId> <版本>  回滚
  remember --kind fact --text "..."  写记忆
  confirm <id> / reject <id>
  memories [--status pending]
  recall <query>
  stats
`);
  }
} catch (e) {
  process.stderr.write('ERROR: ' + (e.message || e) + '\n');
  process.exit(1);
}