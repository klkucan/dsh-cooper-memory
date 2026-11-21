// lib/modules.mjs —— 模块索引
//
// 借鉴代码索引类工具常见的 INDEX 思路：一份"这个模块讲什么"的总览。
// 检索命中时先给模块摘要，模型可以判断"要不要展开这块"，比直接塞 400 字正文省 token。
//
// 切分规则（按路径形状，不依赖具体目录名）：
//   <root>/modules/<x>.md      → <root>/<x>          一个文件一个模块
//   <root>/<group>/<feature>/  → <group>/<feature>   一个目录一个模块
//   <root>/<x>.md              → <root>/<x>          顶层单文件
//   其它                        → <顶层>/<次级>
//
// 摘要用 LLM 批量生成（一次 8 个）。

import { chat } from './llm.mjs';
import { nowIso } from './db.mjs';

/** 文档路径 → 模块 key */
export function moduleKeyOf(relPath) {
  const parts = String(relPath || '').split('/').filter(Boolean);
  const stem = (p) => p.replace(/\.md$/i, '');
  if (!parts.length) return 'root';
  // <root>/modules/<x>.md —— 一个文件一个模块
  if (parts.length === 3 && parts[1] === 'modules') return `${parts[0]}/${stem(parts[2])}`;
  // <root>/<group>/<feature>/… —— 一个目录一个模块
  if (parts.length >= 3) return `${parts[1]}/${parts[2]}`;
  // <root>/<x>.md —— 顶层单文件
  if (parts.length === 2 && /\.md$/i.test(parts[1])) return `${parts[0]}/${stem(parts[1])}`;
  return `${parts[0]}/${parts[1] || 'root'}`;
}

const SYSTEM = `你是知识库目录编纂者。输入若干"模块"及其文档样本，为每个模块写一句中文摘要。
严格输出 JSON 数组，元素形如 {"key":"...","title":"...","summary":"..."}。
- title：模块名，不超过 12 字
- summary：这个模块讲什么，不超过 40 字，一句话，不要以"本模块"开头
- 只使用输入里出现的信息，不得推测`;

/**
 * 批量生成模块摘要。
 * @param {{batch?:number, limit?:number, onProgress?:Function}} opts
 */
export async function buildModuleIndex(db, { batch = 8, limit = 0, onProgress = null } = {}) {
  const docs = db.prepare('SELECT rel_path, id FROM documents ORDER BY rel_path').all();
  const groups = new Map();
  for (const d of docs) {
    const k = moduleKeyOf(d.rel_path);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }

  // 已经是摘要的数据不重复花钱
  const done = new Set(db.prepare('SELECT module_key FROM module_index').all().map((r) => r.module_key));
  let todo = [...groups.entries()].filter(([k]) => !done.has(k));
  if (limit > 0) todo = todo.slice(0, limit);
  if (!todo.length) return { built: 0, total: groups.size, skipped: true };

  const chunkOf = db.prepare(`SELECT heading, text FROM chunks WHERE doc_id = ? ORDER BY ordinal LIMIT 1`);
  const ins = db.prepare(`INSERT OR REPLACE INTO module_index(module_key,title,summary,doc_count,chunk_count,model,updated_at)
    VALUES(?,?,?,?,?,?,?)`);

  let built = 0;
  for (let i = 0; i < todo.length; i += batch) {
    const slice = todo.slice(i, i + batch);
    const payload = slice.map(([key, list]) => {
      const samples = list.slice(0, 3).map((d) => {
        const c = chunkOf.get(d.id);
        const head = c?.heading ? `【${c.heading}】` : '';
        return `${d.rel_path.split('/').pop()} ${head}${String(c?.text || '').replace(/\s+/g, ' ').slice(0, 160)}`;
      });
      return `模块 ${key}（${list.length} 个文档）：\n${samples.join('\n')}`;
    }).join('\n\n');

    let out = '';
    try {
      out = await chat(
        [{ role: 'system', content: SYSTEM }, { role: 'user', content: payload }],
        { maxTokens: 2000, purpose: 'module-index' },
      );
    } catch { continue; }

    let arr = [];
    const m = String(out).match(/\[[\s\S]*\]/);
    if (m) { try { arr = JSON.parse(m[0]); } catch { arr = []; } }
    const byKey = new Map(arr.map((x) => [String(x.key || ''), x]));

    db.exec('BEGIN');
    try {
      for (const [key, list] of slice) {
        const got = byKey.get(key) || {};
        // 按 doc_id 计数，不能按目录 LIKE——qoder 模块是单文件，按目录会把整库都算进去
        const ph = list.map(() => '?').join(',');
        const chunkCount = db.prepare(`SELECT COUNT(*) n FROM chunks WHERE doc_id IN (${ph})`).get(...list.map((d) => d.id)).n;
        ins.run(
          key,
          String(got.title || key.split('/').pop()).slice(0, 40),
          String(got.summary || '').slice(0, 120),
          list.length,
          chunkCount,
          'llm',
          nowIso(),
        );
        if (got.summary) built++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (onProgress) onProgress(Math.min(i + batch, todo.length), todo.length);
  }
  return { built, total: groups.size, pending: groups.size - done.size - built };
}

export function listModules(db, { limit = 200 } = {}) {
  return db.prepare('SELECT * FROM module_index ORDER BY doc_count DESC, module_key LIMIT ?').all(limit);
}

/** 一次取全部模块摘要，供检索时按 key 关联 */
export function moduleSummaryMap(db) {
  const map = new Map();
  for (const r of db.prepare('SELECT module_key, title, summary FROM module_index').all()) {
    map.set(r.module_key, `${r.title}：${r.summary}`.replace(/：$/, ''));
  }
  return map;
}

// 检索路径每个查询都会用到，缓存 60 秒，避免每次都查这张表
let cache = null;
let cacheAt = 0;
export function moduleSummaries(db) {
  if (cache && Date.now() - cacheAt < 60_000) return cache;
  cache = moduleSummaryMap(db);
  cacheAt = Date.now();
  return cache;
}
export function invalidateModuleCache() { cache = null; cacheAt = 0; }