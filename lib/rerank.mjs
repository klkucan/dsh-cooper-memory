// lib/rerank.mjs —— LLM 列表重排（路线 A）
//
// 只在"用户在等结果"的场景用（kb_search / CLI / Web），不进自动注入：
// 一次 1~3 秒，放在每个 step 上不可接受。
//
// 设计要点：
//   - 只把 top-N 的「路径 + 摘要」给模型，不传全文（控 token）
//   - 模型只允许输出编号数组；解析失败、超时、网关不可用 → 原顺序返回
//   - 结果顺序变，分数不变（分数仍来自 RRF，避免两套分数混用）

import { chat } from './llm.mjs';

const SYSTEM = `你是检索结果重排器。用户给一个问题和若干候选片段，你要按"对回答这个问题的帮助程度"排序。
只输出 JSON 数组，元素是候选编号（从 1 开始），按相关度从高到低。不要输出解释、不要 Markdown。`;

/**
 * @param {string} query 用户问题
 * @param {Array} results searchChunks 的结果行
 * @param {{topN?:number, timeoutMs?:number, snippet?:number}} opts
 * @returns {Promise<Array>} 重排后的结果（失败时原样返回）
 */
export async function llmRerank(query, results, { topN = 12, timeoutMs = 8000, snippet = 160 } = {}) {
  if (!Array.isArray(results) || results.length < 3) return results;
  const head = results.slice(0, topN);
  const tail = results.slice(topN);

  const lines = head.map((r, i) => {
    const name = String(r.rel_path || '').split('/').pop();
    const where = r.heading ? `${name}#${r.ordinal}（${String(r.heading).slice(0, 30)}）` : `${name}#${r.ordinal}`;
    const text = String(r.text || '').replace(/\s+/g, ' ').slice(0, snippet);
    return `[${i + 1}] ${where}\n${text}`;
  }).join('\n');

  try {
    // 推理模型会把 token 先花在 reasoning 上：预算给小了正文为空，chat() 会直接抛错。
    // 所以先给 1500，失败再翻倍重试一次。
    let out = '';
    for (const cap of [1500, 3000]) {
      try {
        out = await chat(
          [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: `问题：${query}\n\n候选：\n${lines}\n\n只输出编号数组，例如 [3,1,2]：` },
          ],
          { maxTokens: cap, timeoutMs, purpose: 'rerank' },
        );
        if (String(out).trim()) break;
      } catch (e) {
        if (cap === 3000) throw e;
      }
    }
    const nums = [...String(out).matchAll(/\d+/g)]
      .map((m) => Number(m[0]))
      .filter((n) => n >= 1 && n <= head.length);
    if (!nums.length) return results;

    const seen = new Set();
    const order = [];
    for (const n of nums) if (!seen.has(n)) { seen.add(n); order.push(n); }
    for (let i = 1; i <= head.length; i++) if (!seen.has(i)) order.push(i);

    return [...order.map((n) => head[n - 1]), ...tail];
  } catch {
    // 超时/网关故障/解析失败都不影响主流程
    return results;
  }
}

/**
 * 是否启用 LLM 重排。**默认关**。
 * 实测：在部分模型上质量不稳定（有的查询变好、有的变差），
 * 延迟 3~6 秒。启发式重排已覆盖多数错序，LLM 重排留作手动实验。
 * 开启：MEM_RERANK=1
 */
export function llmRerankEnabled() {
  const v = String(process.env.MEM_RERANK ?? '').toLowerCase();
  return v === '1' || v === 'on' || v === 'true';
}