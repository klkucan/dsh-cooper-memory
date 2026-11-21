// lib/usage.mjs —— LLM 调用记账与汇总
//
// 借鉴 dsh-prime-memory 的成本看板：每次蒸馏/探针调用都落一行，
// 按 provider/model/日期聚合。记账失败只告警，绝不阻塞主流程。

import { nowIso } from './db.mjs';

/** 供 llm.mjs 注入的记录器（避免 llm 层依赖 db 连接） */
let recorder = null;

export function setRecorder(fn) {
  recorder = typeof fn === 'function' ? fn : null;
}

export function emit(rec) {
  if (!recorder) return;
  try { recorder({ at: nowIso(), ok: 1, ...rec }); } catch { /* 记账失败不影响调用 */ }
}

export function recordUsage(db, row) {
  try {
    db.prepare(`INSERT INTO llm_usage(at,purpose,provider,model,prompt_chars,prompt_tokens,completion_tokens,reasoning_tokens,total_tokens,duration_ms,ok,error)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.at || nowIso(), row.purpose || '', row.provider || '', row.model || '',
      row.prompt_chars ?? 0, row.prompt_tokens ?? 0, row.completion_tokens ?? 0,
      row.reasoning_tokens ?? 0, row.total_tokens ?? 0, row.duration_ms ?? 0,
      row.ok ? 1 : 0, row.error ?? null,
    );
  } catch (e) {
    if (process.env.MEM_DEBUG) process.stderr.write('[usage] record failed: ' + e.message + '\n');
  }
}

/** 按天 + 模型聚合 */
export function usageSummary(db, { days = 30, purpose = null } = {}) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const args = [since];
  let where = 'at >= ?';
  if (purpose) { where += ' AND purpose = ?'; args.push(purpose); }

  const byModel = db.prepare(`
    SELECT provider, model, COUNT(*) calls,
           SUM(prompt_tokens) prompt_tokens, SUM(completion_tokens) completion_tokens,
           SUM(reasoning_tokens) reasoning_tokens, SUM(total_tokens) total_tokens,
           SUM(ok=0) failed, ROUND(AVG(duration_ms)) avg_ms
    FROM llm_usage WHERE ${where}
    GROUP BY provider, model ORDER BY total_tokens DESC`).all(...args);

  const byDay = db.prepare(`
    SELECT substr(at,1,10) day, COUNT(*) calls, SUM(total_tokens) total_tokens
    FROM llm_usage WHERE ${where}
    GROUP BY day ORDER BY day DESC LIMIT 60`).all(...args);

  const byPurpose = db.prepare(`
    SELECT purpose, COUNT(*) calls, SUM(total_tokens) total_tokens
    FROM llm_usage WHERE ${where}
    GROUP BY purpose ORDER BY total_tokens DESC`).all(...args);

  const total = db.prepare(`
    SELECT COUNT(*) calls, COALESCE(SUM(total_tokens),0) total_tokens,
           COALESCE(SUM(ok=0),0) failed
    FROM llm_usage WHERE ${where}`).get(...args);

  return { days, total, byModel, byDay, byPurpose };
}