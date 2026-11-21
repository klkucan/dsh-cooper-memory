// lib/profile.mjs —— L3 常驻画像
//
// L1 事实靠关键词匹配召回，L2 场景靠主题命中；但"用户是谁"这件事不该依赖查询词。
// L3 把画像类记忆（profile / preference / interest）压成一段固定文本，每轮注入。
//
// 缓存策略：把输入的 id 集合哈希成 signature，输入变了才重算；
// 另外设最长有效期，避免长期不更新。

import crypto from 'node:crypto';
import { getMeta, setMeta, nowIso } from './db.mjs';
import { chat } from './llm.mjs';

const PROFILE_SYSTEM = `你是用户画像压缩器。输入是若干条关于用户的长期记忆。

请把它们合并成一段紧凑的用户画像，要求：
- 纯文本，不要 Markdown 标记、不要分点符号、不要小标题
- 按"身份 → 技术栈 → 工作偏好"的顺序写，一段话
- 只写稳定的、跨会话依然成立的特征
- 不要罗列做过什么任务，不要写项目细节
- 不得编造输入里没有的内容
- 不超 {{MAXCHARS}} 字

直接输出画像正文，不要任何解释。`;

const SIG_LIMIT = 60;

function signatureOf(rows) {
  const ids = rows.map((r) => r.id).sort((a, b) => a - b).join(',');
  return crypto.createHash('sha1').update(ids).digest('hex').slice(0, 16);
}

export function pickProfileSources(db, { limit = 40 } = {}) {
  return db.prepare(`
    SELECT id, kind, text FROM memories
    WHERE status='active' AND kind IN ('profile','preference','interest')
    ORDER BY kind='profile' DESC, confidence DESC, id DESC
    LIMIT ?`).all(limit);
}

export function getProfileBlock(db) {
  return {
    text: getMeta(db, 'profile_block') || '',
    at: getMeta(db, 'profile_block_at') || null,
    sig: getMeta(db, 'profile_sig') || null,
  };
}

/** 输入是否变化 / 是否过期 */
export function profileNeedsRefresh(db, { rows = null, maxAgeDays = 7 } = {}) {
  const src = rows || pickProfileSources(db);
  const sig = signatureOf(src);
  const cur = getProfileBlock(db);
  if (!cur.text) return { need: true, reason: 'empty', sig };
  if (cur.sig !== sig) return { need: true, reason: 'sources-changed', sig };
  if (cur.at) {
    const ageDays = (Date.now() - new Date(cur.at).getTime()) / 86400000;
    if (ageDays > maxAgeDays) return { need: true, reason: `stale ${Math.round(ageDays)}d`, sig };
  }
  return { need: false, reason: 'fresh', sig };
}

/**
 * 重新生成画像。
 * @param {{dryRun?:boolean, maxChars?:number, model?:string}} opts
 */
export async function buildProfile(db, { dryRun = false, maxChars = 400, model = null } = {}) {
  const rows = pickProfileSources(db);
  if (!rows.length) return { skipped: 'no profile memories', count: 0 };

  const payload = rows.map((r, i) => `${i + 1}. [${r.kind}] ${r.text}`).join('\n');
  const out = await chat(
    [
      { role: 'system', content: PROFILE_SYSTEM.replace('{{MAXCHARS}}', String(maxChars)) },
      { role: 'user', content: payload },
    ],
    { maxTokens: 1200, purpose: 'l3-profile', model },
  );
  let text = String(out).trim().replace(/\s+/g, ' ');
  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    // 宁可短一点，也不要截在半句上
    const idx = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'));
    text = idx > maxChars * 0.6 ? cut.slice(0, idx + 1) : cut;
  }
  const sig = signatureOf(rows);

  if (!dryRun) {
    setMeta(db, 'profile_block', text);
    setMeta(db, 'profile_block_at', nowIso());
    setMeta(db, 'profile_sig', sig);
  }
  return { text, chars: text.length, sources: rows.length, sig, dryRun };
}