// lib/vector.mjs —— 本地向量层（bge-small-zh-v1.5 + @xenova/transformers）
//
// 分工：
//   本文件   文本 → 512 维向量（用本地 ONNX 模型，纯 WASM，无原生依赖）
//   db       向量存成 BLOB（int8 量化），见 chunk_vectors 表
//   core     向量路作为第 4 路召回，参与 RRF 融合
//
// 设计约束：
//   - 懒加载：插件启动不加载 24 MB 模型，第一次真正用到时才初始化
//   - 不联网：allowRemoteModels=false，模型只从本包 models/ 目录读
//   - 可选：@xenova/transformers 没装时全是 no-op，检索自动退回词面

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MODEL_ROOT = path.join(here, '..', 'models');
export const MODEL_ID = 'bge-small-zh-v1.5';
export const DIM = 512;

let pipelinePromise = null;
let loadError = null;

/** 运行时依赖是否可用（没装就退回纯词面） */
export async function vectorAvailable() {
  try {
    await import('@xenova/transformers');
    return true;
  } catch (e) {
    loadError = e?.message || String(e);
    return false;
  }
}

async function getExtractor() {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    const { env, pipeline } = await import('@xenova/transformers');
    // 只用本地模型：这台机器连不上 huggingface.co
    env.localModelPath = `${MODEL_ROOT}${path.sep}`;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = 1;
    return pipeline('feature-extraction', MODEL_ID, { quantized: true });
  })();
  return pipelinePromise;
}

/**
 * 批量编码。
 * @param {string[]} texts
 * @param {{batchSize?:number}} opts
 * @returns {Promise<Float32Array[]>} 每条一个 512 维、已 L2 归一化的向量
 */
export async function embedBatch(texts, { batchSize = 16 } = {}) {
  const list = (texts || []).map((t) => String(t || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!list.length) return [];
  const extractor = await getExtractor();
  const out = [];
  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    // BGE 系列用 CLS 池化（不是 mean）+ 归一化；查询侧加检索指令前缀（见 embedQuery）
    const res = await extractor(batch, { pooling: 'cls', normalize: true });
    for (const item of res) out.push(Float32Array.from(item.data));
  }
  return out;
}

/** bge 系列检索约定：查询加任务指令，文档不加 */
export async function embedQuery(text) {
  const [v] = await embedBatch([`为这个句子生成表示以用于检索相关文章：${text}`], { batchSize: 1 });
  return v || null;
}

// ---------- 量化与距离 ----------

/** Float32 → int8 + scale（每维 1 字节，512 维从 2KB 降到 512B） */
export function quantize(vec) {
  let max = 0;
  for (const v of vec) if (Math.abs(v) > max) max = Math.abs(v);
  const scale = max / 127 || 1;
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(vec[i] / scale)));
  return { q, scale };
}

export function dequantize(q, scale) {
  const f = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) f[i] = q[i] * scale;
  return f;
}

/** 余弦相似度（两边都已归一化时等价于点积） */
export function cosine(a, b) {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

export function vectorStatus() {
  return { modelId: MODEL_ID, dim: DIM, modelRoot: MODEL_ROOT, loadError };
}

// ---------- 索引构建与检索 ----------

/** 内存索引缓存：全库向量载入一次后复用，重算时才失效 */
let indexCache = null;
export function invalidateVectorCache() { indexCache = null; }

/**
 * 告诉其它进程"向量变了"。
 * 触发器删掉 chunk_vectors 行时不会动 meta，所以编辑/回滚/重导这些路径要显式调一次，
 * 否则宿主的缓存会一直按已被删除的旧向量排序。
 */
export function touchVectorVersion(db) {
  try {
    db.prepare("INSERT INTO meta(key,value) VALUES('vector_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(Date.now()));
    invalidateVectorCache();
  } catch { /* meta 异常不影响主流程 */ }
}

/**
 * 载入全部向量到内存（int8 矩阵）。
 * 20447 × 512 字节 ≈ 10 MB，比每次查询读库快得多。
 */
function vectorVersion(db) {
  try { return db.prepare("SELECT value FROM meta WHERE key='vector_version'").get()?.value || '0'; } catch { return '0'; }
}

function loadIndex(db, _retried = false) {
  // 跨进程失效：向量由 CLI/MCP 建好后，宿主进程的缓存必须能感知到
  const ver = vectorVersion(db);
  if (indexCache && indexCache.ver === ver) return indexCache;
  const rows = db.prepare('SELECT chunk_id, dim, scale, vec FROM chunk_vectors').all();
  if (!rows.length) { indexCache = { ids: [], mat: null, scales: [], dim: 0, ver }; return indexCache; }
  const dim = rows[0].dim;
  const n = rows.length;
  const mat = new Int8Array(n * dim);
  const ids = new Array(n);
  const scales = new Float64Array(n);
  rows.forEach((r, i) => {
    ids[i] = r.chunk_id;
    scales[i] = r.scale;
    const buf = r.vec;
    for (let d = 0; d < dim; d++) mat[i * dim + d] = buf.readInt8 ? buf.readInt8(d) : buf[d];
  });
  // 边读边有别的进程写入时，读到的行和版本戳可能不同源：复核一次，变了就重读
  const verAfter = vectorVersion(db);
  if (verAfter !== ver && !_retried) { indexCache = null; return loadIndex(db, true); }
  indexCache = { ids, mat, scales, dim, n, ver: verAfter };
  return indexCache;
}

/**
 * 批量构建向量索引。
 * @param {{batchSize?:number, limit?:number, onProgress?:(done,total)=>void}} opts
 */
export async function buildVectors(db, { batchSize = 16, limit = 0, onProgress = null } = {}) {
  const todo = db.prepare(`
    SELECT c.id, c.text, c.heading, c.context_header FROM chunks c
    LEFT JOIN chunk_vectors v ON v.chunk_id = c.id
    WHERE v.chunk_id IS NULL
    ${limit ? 'LIMIT ' + Number(limit) : ''}`).all();
  if (!todo.length) return { done: 0, total: 0, skipped: true };

  const ins = db.prepare('INSERT OR REPLACE INTO chunk_vectors(chunk_id,dim,scale,vec,model,created_at) VALUES(?,?,?,?,?,?)');
  let done = 0;
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const texts = batch.map((c) => ((c.context_header ? c.context_header + '\n' : '') + c.text).slice(0, 600));
    const vecs = await embedBatch(texts, { batchSize });
    db.exec('BEGIN');
    try {
      batch.forEach((c, k) => {
        const { q, scale } = quantize(vecs[k]);
        ins.run(c.id, vecs[k].length, scale, Buffer.from(q.buffer), MODEL_ID, new Date().toISOString());
      });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    done += batch.length;
    if (onProgress) onProgress(done, todo.length);
  }
  invalidateVectorCache();
  // 写一个版本戳，其它进程据此判断"向量变了"（不依赖文件 mtime，SQLite 更可靠）
  try {
    const v = String(Date.now());
    db.prepare("INSERT INTO meta(key,value) VALUES('vector_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(v);
  } catch { /* meta 表异常不影响主流程 */ }
  return { done, total: todo.length };
}

/**
 * 向量检索：返回按相似度排序的分块行（字段与词面路一致，便于融合）。
 * 查询向量已是归一化的，文档向量也已归一化，点积即余弦。
 */
export function searchVectors(db, qvec, { limit = 60 } = {}) {
  const { ids, mat, scales, dim, n } = loadIndex(db);
  if (!n || dim !== qvec.length) return [];
  const scored = [];
  for (let i = 0; i < n; i++) {
    let dot = 0;
    const base = i * dim;
    for (let d = 0; d < dim; d++) dot += mat[base + d] * qvec[d];
    scored.push({ id: ids[i], score: dot * scales[i] });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  const placeholders = top.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT c.id, c.doc_id, c.ordinal, c.text, c.heading, c.context_header, d.rel_path
    FROM chunks c JOIN documents d ON d.id = c.doc_id
    WHERE c.id IN (${placeholders})`).all(...top.map((t) => t.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return top.map((t) => {
    const row = byId.get(t.id);
    return row ? { ...row, vscore: t.score } : null;
  }).filter(Boolean);
}

export function vectorStats(db) {
  const total = db.prepare('SELECT COUNT(*) n FROM chunks').get().n;
  const done = db.prepare('SELECT COUNT(*) n FROM chunk_vectors').get().n;
  return { chunks: total, vectors: done, pending: total - done, dim: DIM, model: MODEL_ID };
}