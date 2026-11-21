// lib/tokenize.mjs —— 中文分词（jieba 词元 + CJK 二元组并集）
//
// 借鉴 dsh-prime-memory：
//   - jieba 词元负责 BM25 的"整词精确命中"
//   - CJK 二元组负责"子词召回"（未登录词、缩写、错别字也能命中）
//   - jieba 加载失败时整体退化为纯二元组，保证功能不残
//
// @node-rs/jieba 是原生模块，加载成本约 5 MB 词典 + 首次切词预热；
// 因此用单例 + 懒加载，MCP 进程启动时不付这个代价。

let jieba = null;
let loadState = 'idle'; // idle | loading | ready | failed
let loadError = null;
let loading = null;

/** 标点、空白、纯符号一律丢弃 */
const isNoise = (t) => !/[\p{L}\p{N}]/u.test(t);

const CJK = /[\u4e00-\u9fff]/;

/** CJK 二元组 */
function bigrams(text) {
  const out = new Set();
  const runs = text.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of runs) {
    if (run.length === 1) { out.add(run); continue; }
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

async function loadJieba() {
  if (loadState === 'ready') return jieba;
  if (loadState === 'failed') return null;
  if (loading) return loading;
  loading = (async () => {
    loadState = 'loading';
    try {
      const pkg = await import('@node-rs/jieba');
      const dictMod = await import('@node-rs/jieba/dict.js');
      const dict = dictMod.dict ?? dictMod.default;
      const { Jieba } = pkg;
      if (!Jieba || !dict) throw new Error('jieba: 缺少 Jieba 或 dict 导出');
      jieba = Jieba.withDict(dict);
      loadState = 'ready';
      return jieba;
    } catch (e) {
      loadState = 'failed';
      loadError = String(e?.message || e);
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** 预热分词器（可选调用，失败不影响功能） */
export async function warmup() {
  await loadJieba();
  return { state: loadState, error: loadError };
}

export function tokenizerState() {
  return { state: loadState, error: loadError };
}

/**
 * 同步分词：仅在已预热（或退化）时可用。
 * 返回空格分隔的词元串，供 FTS5 unicode61 建索引。
 */
export function tokenizeSync(text) {
  const s = String(text || '');
  if (!s) return '';
  const set = new Set();

  if (loadState === 'ready' && jieba) {
    try {
      for (const t of jieba.cutForSearch(s)) {
        const w = t.trim().toLowerCase();
        if (!w || isNoise(w)) continue;
        set.add(w);
      }
    } catch { /* 单次切词失败就只用二元组 */ }
  } else {
    // 退化路径：英文/数字按词，中文按二元组
    for (const m of s.matchAll(/[A-Za-z0-9_.-]{2,}/g)) set.add(m[0].toLowerCase());
  }

  // 无论 jieba 是否可用，都补上 CJK 二元组（子词召回）
  for (const b of bigrams(s)) set.add(b);

  return [...set].join(' ');
}

/** 异步版：确保 jieba 已加载后再分词 */
export async function tokenize(text) {
  await loadJieba();
  return tokenizeSync(text);
}

/** 查询侧分词：只要词元，不要全文二元组噪音（保留二元组用于短查询） */
export function tokenizeQuery(q) {
  const s = String(q || '').trim();
  if (!s) return [];
  const terms = new Set();
  if (loadState === 'ready' && jieba) {
    try {
      for (const t of jieba.cutForSearch(s)) {
        const w = t.trim().toLowerCase();
        if (!w || isNoise(w) || w.length < 1) continue;
        if (CJK.test(w) && w.length < 2) continue; // 单字词留作兜底，不进主查询
        terms.add(w);
      }
    } catch { /* ignore */ }
  }
  for (const m of s.matchAll(/[A-Za-z0-9_.-]{2,}/g)) terms.add(m[0].toLowerCase());
  for (const b of bigrams(s)) terms.add(b);
  return [...terms];
}

/**
 * 只取"词"，不取二元组——用于查询意图判定。
 * 二元组会切出「族升」「级怎」这类跨词碎片，把噪声顶进匹配。
 * jieba 不可用时退化为二元组（聊胜于无）。
 */
export function segmentWords(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  const out = new Set();
  if (loadState === 'ready' && jieba) {
    try {
      for (const t of jieba.cutForSearch(s)) {
        const w = t.trim().toLowerCase();
        if (!w || isNoise(w)) continue;
        if (CJK.test(w) && w.length < 2) continue;   // 中文单字不成词
        if (!CJK.test(w) && w.length < 2) continue;  // 英文单字母无意义
        out.add(w);
      }
      return [...out];
    } catch { /* 退化 */ }
  }
  for (const m of s.matchAll(/[A-Za-z0-9_.-]{2,}/g)) out.add(m[0].toLowerCase());
  for (const b of bigrams(s)) out.add(b);
  return [...out];
}