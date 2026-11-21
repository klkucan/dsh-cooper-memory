// lib/terms.mjs —— 查询词提取与"判别力"过滤
//
// 为什么需要这一步：停用词表只能挡住一部分。"全部""删掉""新建""存在"这类词
// 在任何一个 2 万块的技术库里都出现几十上百次，用它们做匹配必然召出噪声
// （实测：一条操作类指令召回了若干份与主题无关的文档）。
//
// 做法：用 FTS 的 MATCH 快速统计每个词出现在多少个分块里（df），
// df 过高的词视为"没有判别力"，不参与匹配。标识符（英文/带下划线）例外——
// NpcCreateConfig 这种词本身就是强信号。

import { segmentWords } from './tokenize.mjs';

export const QUERY_STOP = new Set([
  '你好', '您好', '谢谢', '麻烦', '请问', '帮我看', '帮我', '帮忙', '看看', '看一下',
  '今天', '明天', '昨天', '现在', '继续', '接着', '然后', '还有', '另外',
  '这个', '那个', '这里', '那里', '这样', '那样', '这些', '那些',
  '我们', '你们', '他们', '自己', '大家',
  '什么', '怎么', '为什么', '如何', '可以', '需要', '应该', '是不是',
  '一个', '一下', '一些', '东西', '事情', '问题', '情况', '地方', '方式',
  '功能', '处理', '好的', '嗯嗯', '收到', '试试', '感觉', '不对', '还是', '就是',
  // 增补：动作类 / 泛指词，几乎在任何技术库里都高频
  '全部', '所有', '列出', '罗列', '删掉', '删除', '删除掉', '新建', '创建', '生成',
  '提示', '存在', '仍旧', '仍然', '但是', '因为', '所以', '如果', '已经', '直接',
  '目前', '当前', '开始', '结束', '看看', '帮我查', '查一下', '看一下',
  '编写', '撰写', '做', '搞', '弄', '写', '改', '加', '去掉',
]);

const isIdentifier = (t) => /^[A-Za-z][A-Za-z0-9_]{2,}$/.test(t);

/** 停用词过滤后的有效词（纯函数，不需要 db） */
export function effectiveTerms(query) {
  return segmentWords(query)
    .filter((t) => !QUERY_STOP.has(t) && !/^\d+$/.test(t))
    .slice(0, 12);
}

const DF_CACHE = new Map();

/** 词出现在多少个分块里（走 FTS，很快） */
export function dfOf(db, term) {
  const k = String(term).toLowerCase();
  if (DF_CACHE.has(k)) return DF_CACHE.get(k);
  let n = 0;
  try {
    n = db.prepare('SELECT COUNT(*) n FROM chunks_fts_tokens WHERE tokens MATCH ?').get(`"${k}"`).n;
  } catch { n = 0; }
  DF_CACHE.set(k, n);
  return n;
}

let TOTAL_CACHE = 0;
function totalChunks(db) {
  if (TOTAL_CACHE) return TOTAL_CACHE;
  try { TOTAL_CACHE = db.prepare('SELECT COUNT(*) n FROM chunks').get().n || 0; } catch { TOTAL_CACHE = 0; }
  return TOTAL_CACHE;
}

/**
 * 有判别力的词。
 *
 * 不能用绝对阈值：垂直领域库里，"订单""接口""升级"这类词在任何文档里都会出现，
 * 但它们恰恰可能是有效查询词。所以按"占库比例"判断——只丢真正泛化的词（>30% 的分块），
 * 并且保证至少留下 df 最小的 2 个，避免把正常查询误杀成空。
 */
export function distinctiveTerms(db, query, { ubiquity = 0.3, minKeep = 2 } = {}) {
  const terms = effectiveTerms(query);
  if (!terms.length) return [];
  const total = totalChunks(db) || 1;
  const limit = Math.max(50, total * ubiquity);
  const scored = terms.map((t) => ({ t, df: isIdentifier(t) ? 0 : dfOf(db, t) }));
  const keep = scored.filter((x) => x.df <= limit).map((x) => x.t);
  if (keep.length >= minKeep) return keep;
  const sorted = [...scored].sort((a, b) => a.df - b.df);
  return sorted.slice(0, Math.min(minKeep, sorted.length)).map((x) => x.t);
}

export function invalidateDfCache() { DF_CACHE.clear(); TOTAL_CACHE = 0; }

/**
 * 这条消息是不是"在问项目知识"。
 *
 * 知识库装的是模块文档，回答的是"怎么运作/有哪些规则"，不是"帮我把这几条删了"。
 * 实测："把v1-v4全部删掉""罗列出所有玩家昵称" 这类操作指令会命中 scan_data、
 * 无关文档，而真正的主题查询会命中对应模块的文档。
 * 用提问意图做闸门，比调词频阈值可靠。
 */
const QUESTION_MARK = /(怎么|如何|为什么|是什么|哪些|哪个|区别|规则|流程|机制|原理|配置|实现|字段|接口|表结构|报错|异常|设计|方案|支持|有没有)/;

export function isKnowledgeQuestion(query) {
  const s = String(query || '').trim();
  if (s.length < 6) return false;
  return QUESTION_MARK.test(s);
}