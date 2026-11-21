// lib/extract.mjs —— 自动提取记忆（无需 LLM，服务进程出不了网也能跑）
//
// 设计参照 WeKnora 的 auto 模式（23-memory.md:13-18）：
//   - 后台从会话提取，不阻塞对话
//   - 提取结果一律 pending，确认后才注入
//   - 拒绝过的内容留抑制记录，不再重复提取
//   - 有延迟与最短间隔（这里用"文件水位线 + 每轮上限"近似）
//
// 与 WeKnora 的差异：它用 LLM 蒸馏，这里用规则打分（本机服务访问不到 API）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { nowIso, getMeta, setMeta } from './db.mjs';
import { findConflict } from './core.mjs';
import { segmentWords } from './tokenize.mjs';
import { append as journalAppend } from './journal.mjs';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 会话文件是追加式多 zstd frame，按魔数切帧逐个解 */
export function readSessionLines(file) {
  const buf = fs.readFileSync(file);
  if (!file.endsWith('.zstd')) return buf.toString('utf8').split('\n').filter(Boolean);
  const offs = [];
  let i = -1;
  while ((i = buf.indexOf(ZSTD_MAGIC, i + 1)) !== -1) offs.push(i);
  let text = '';
  for (let k = 0; k < offs.length; k++) {
    const s = offs[k];
    const e = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); } catch { /* 跳过坏帧 */ }
  }
  return text.split('\n').filter(Boolean);
}

const NOISE_PREFIX = [
  'Current runtime context', 'The following information describes',
  // 旧记忆导入时会在正文前带一个方括号来源标记，这类文本不是用户发言，不进蒸馏
  'System reminder', /^【[^】]{1,8}】/, 'Workspace instructions',
  '<system-reminder', '<', 'Time sampled', 'Elapsed since', '(Omitted',
  'background job ', 'pwsh-', '--- [', 'BUILD ', 'node.exe :', 'started background job',
];

/** 抽出真实的用户发言（排除注入的运行时上下文/提醒） */
export function collectUserTurns(file) {
  const turns = [];
  for (const line of readSessionLines(file)) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type !== 'user/message') continue;
    // 按来源过滤：其他插件注入的消息正文没有固定前缀，只能靠 source.kind 识别
    const srcKind = String(ev.data?.source?.kind || '');
    if (srcKind && srcKind !== 'user') continue;
    const parts = ev.data?.content;
    if (!Array.isArray(parts)) continue;
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim();
    if (!text) continue;
    if (NOISE_PREFIX.some((p) => (p instanceof RegExp ? p.test(text) : text.startsWith(p)))) continue;
    if (text.length < 4) continue;
    // 系统级通知（"用户把审批策略设置为…"）不是用户发言，不进蒸馏，省 token
    if (isHarnessNoise(text)) continue;
    turns.push({ seq: ev.seq, time: ev.time, text });
  }
  return turns;
}

// ---------- 规则 ----------
const FIRST_PERSON = /(我|我们|我的|咱|本人)/;
const MEMORY_VERB = /(记住|记一下|记下来|别忘|以后都|以后不要|以后别|从现在开始|下次要|下次别|请你记)/;

const RULES = [
  // 显式要求记住 —— 最强信号
  { kind: 'preference', weight: 0.9, re: MEMORY_VERB },
  // 明确的偏好/意图陈述
  { kind: 'preference', weight: 0.8, re: /(我(更|比较|最)?(喜欢|偏好|习惯|倾向)|我不(喜欢|想要|希望)|不要用|别用|一律|必须是|千万(别|不要)|我希望你|我要求你|我只要|我就想要|我需要的?是|别一开始|别一上来|不要一开始)/ },
  // 身份 / 能力画像
  { kind: 'profile', weight: 0.82, re: /(我是(一|个|做|搞|写)?|我叫|我在.{0,15}(工作|上班)|我负责|我的(角色|岗位|职责)|我不懂|我不会|我是新手|我熟悉|我做过|我搞过)/ },
  // 项目 / 仓库事实
  { kind: 'fact', weight: 0.76, re: /(我的?(项目|仓库|配置|目录).{0,8}(是|叫|在|用)|这个项目(用|是|只)|我们的(项目|团队|环境)|原因是|根源是|导致)/ },
  // 本机环境事实（联网/读写/路径这类硬约束）
  { kind: 'fact', weight: 0.74, re: /((我|我的).{0,10}(环境|机器|电脑|系统|工作区))|(我(这边|这里)?).{0,8}(无法|不能|只能|可以|不行)|([A-Za-z甲乙丙丁])?\s?盘.{0,12}(不能|无法|可以|能|不行)/ },
  { kind: 'todo', weight: 0.8, re: /(待办|提醒我|记得做|回头要|后续要|等下要|稍后要)/ },
];

// 提问、抱怨、指令性噪音：除非显式要求记住，否则一律不收
const NOISE = /(你是不是|你搞错|你确定|为什么|怎么|什么|吗[？?]?$|呢[？?]?$|吧$|能不能|可不可以|有没有|帮我|检查一下|试试|看看$|你看下|是否可行)/;

const splitSentences = (text) =>
  text.split(/(?<=[。！？!?；;\n，,])/).map((s) => s.trim()).filter(Boolean);

function scoreSentence(sentence) {
  if (sentence.length < 8 || sentence.length > 240) return null;
  if (/[?？]\s*$/.test(sentence)) return null;               // 问句不收
  const explicit = MEMORY_VERB.test(sentence);
  if (!FIRST_PERSON.test(sentence) && !explicit) return null;
  if (/^\s*你/.test(sentence) && !explicit) return null;     // 对助手的指令，不是关于我的
  if (!explicit && NOISE.test(sentence)) return null;        // 噪音句只放行"记住…"
  let best = null;
  for (const r of RULES) {
    if (!r.re.test(sentence)) continue;
    if (!best || r.weight > best.weight) best = { kind: r.kind, weight: r.weight };
  }
  return best;
}

/**
 * 元配置噪声：描述"本会话把某个开关调成了什么"，而不是用户长期有效的偏好/事实。
 * 这类内容每换一次设置就产一条，且对后续会话毫无价值，直接拦掉。
 *
 * 注意不能泛化到"用户把 X 设置为 Y"——那是正常的偏好表述。
 */
const HARNESS_NOISE = [
  // 强特征：本身就是配置名词
  /(审批策略|审批模式|approval\s*(policy|mode)|不再询问用户批准|自动批准请求)/i,
  /(记忆档位|记忆开关|注入开关|只写不读|召回开关)/,
  /(沙箱权限模式|权限模式|工作区权限模式)/,
  /(模型选择设置|默认模型设置|切换默认模型)/,
  // 弱特征 + 设置动词：必须同时出现，避免误伤"沙箱限制跨盘写入"这类环境事实
  /(沙箱|sandbox|权限|模型|会话).{0,12}(设置为|切换为|调整为|改成|启用|关闭|开启)/i,
  /(设置为|切换为|调整为|改成).{0,12}(沙箱|sandbox|审批|权限模式|记忆档位)/i,
];

export function isHarnessNoise(text) {
  const s = String(text || '');
  if (!s) return false;
  return HARNESS_NOISE.some((re) => re.test(s));
}

const normalize = (s) => s
  .replace(/^[\s\-*•\d.、)）]+/, '')
  .replace(/\s+/g, ' ')
  .replace(/[。！？!?；;，,、]+$/, '')
  .trim();

export const dedupeKey = (s) => normalize(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

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

/**
 * 判重阈值按长度分档。
 * 短句 trigram 只有十几个，改一个词就能让 jaccard 掉到 0.6——阈值定高了会把
 * 同一件事判成两条，定低了又会把两件不同的事合并。所以：
 *   短句要更严（接近逐字相同才算重复）
 *   长句可以更松（差异被长度稀释，90% 重合基本就是同一句）
 * 长度差超过 2.5 倍的，不判重（长的很可能是短句的补充版本，交给 supersede）。
 */
export function dedupeThreshold(a, b) {
  const min = Math.min(a.length, b.length);
  const max = Math.max(a.length, b.length);
  if (min === 0) return 1.01;
  if (max / min > 2.5) return 1.01;
  if (max < 30) return 0.90;   // 短句：几乎要逐字相同，措辞变了交给 supersede
  if (max <= 100) return 0.80; // 实测"同一句改一个词"约 0.86
  return 0.78;                 // 长句：差异被长度稀释
}

/** 两个文本是否算同一条记忆（长度感知） */
export function isDuplicateText(a, b, triA = null, triB = null) {
  const ta = triA || toTrigrams(a);
  const tb = triB || toTrigrams(b);
  return jaccard(ta, tb) >= dedupeThreshold(a, b);
}

function walkSessions(dir) {
  const out = [];
  const walk = (d) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl') || e.name.endsWith('.jsonl.zstd')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * 扫描会话日志，把候选记忆写成 pending
 * @param {object} db
 * @param {{sessionsDir?:string, limit?:number, dryRun?:boolean, maxFiles?:number, minAgeMs?:number}} opts
 */
export function runAutoExtract(db, opts = {}) {
  const sessionsDir = opts.sessionsDir || path.join(os.homedir(), '.dsh', 'sessions');
  const limit = opts.limit ?? 30;
  const dryRun = !!opts.dryRun;
  const maxFiles = opts.maxFiles ?? 50;
  const admit = opts.admit !== false;   // 分级准入：够格直接 active

  const files = walkSessions(sessionsDir).slice(-maxFiles);
  const existing = db.prepare("SELECT text FROM memories WHERE status IN ('pending','active','rejected')").all();
  const existingKeys = new Set(existing.map((m) => dedupeKey(m.text)));
  const existingTri = existing.map((m) => ({ text: m.text, tri: toTrigrams(m.text) }));

  const result = {
    scannedFiles: 0, newFiles: 0, turns: 0, candidates: 0,
    added: [], skipped: { dup: 0, short: 0, weak: 0 }, dryRun,
  };
  const seen = new Set();

  for (const file of files) {
    const st = fs.statSync(file);
    const rel = path.relative(sessionsDir, file);
    const stamp = `${st.size}:${st.mtimeMs}`;
    result.scannedFiles++;
    if (!dryRun && getMeta(db, 'extract:' + rel) === stamp) continue;
    result.newFiles++;

    const turns = collectUserTurns(file);
    result.turns += turns.length;
    for (const t of turns) {
      for (const raw of splitSentences(t.text)) {
        const scored = scoreSentence(raw);
        if (!scored) continue;
        const text = normalize(raw);
        if (text.length < 8) { result.skipped.short++; continue; }
        if (isHarnessNoise(text)) { result.skipped.noise = (result.skipped.noise || 0) + 1; continue; }
        const key = dedupeKey(text);
        if (existingKeys.has(key) || seen.has(key)) { result.skipped.dup++; continue; }
        const tri = toTrigrams(text);
        const nearDup = existingTri.some((e) => jaccard(tri, e.tri) > 0.85);
        if (nearDup) { result.skipped.dup++; continue; }
        seen.add(key);
        const cand = {
          kind: scored.kind, text, confidence: scored.weight,
          source: 'auto:' + rel.replace(/\\/g, '/'),
        };
        result.candidates++;
        if (dryRun) { if (result.added.length < limit) result.added.push(cand); continue; }
        if (result.added.length >= limit) continue;
        const auto = admit && shouldAutoAdmit(cand);
        const status = auto ? 'active' : 'pending';
        const now = nowIso();
        const r = db.prepare(`INSERT INTO memories(kind,subject,text,status,confidence,source,tags,created_at,confirmed_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(cand.kind, '', cand.text, status, cand.confidence, cand.source, auto ? 'auto,auto-admitted' : 'auto', now, auto ? now : null);
        db.prepare('INSERT INTO memory_versions(memory_id,version,text,editor,note,created_at) VALUES(?,1,?,?,?,?)')
          .run(Number(r.lastInsertRowid), cand.text, 'auto-extract', status, now);
        journalAppend({ op: 'put', id: Number(r.lastInsertRowid), kind: cand.kind, subject: '', text: cand.text, status, confidence: cand.confidence, source: cand.source, tags: auto ? 'auto,auto-admitted' : 'auto', created_at: now, supersedes_id: null, detail: null, version: 1 });
        result.added.push({ id: Number(r.lastInsertRowid), status, ...cand });
      }
    }
    if (!dryRun) setMeta(db, 'extract:' + rel, stamp);
  }
  if (!dryRun) setMeta(db, 'last_extract_at', nowIso());
  return result;
}

// ---------------- LLM 蒸馏（可选，取决于服务进程能否出网） ----------------
import { chat, chatWithRetry } from './llm.mjs';

const DISTILL_SYSTEM = `你是长期记忆提取器。输入是用户在一段对话里的原话（可能多条）。
请只提取**关于用户本人**、且**长期有效**的信息，输出 JSON 数组，不要输出任何解释。

可提取的类型：
- profile：身份/职业/技能水平（例：用户不懂 Docker）
- preference：稳定的偏好与要求（例：回答用中文、先给结论）
- fact：环境中长期成立的事实（例：C 盘无法联网，D 盘可以）
- todo：用户明确要求以后要做的事

不要提取：
- 一次性的任务请求（"帮我改这个文件"）
- 临时的运行状态（"现在启动不了"）
- 疑问句、抱怨、对助手的指令
- 对话里没有依据的推测

必须严格输出这个形状的 JSON 数组，字段名只能是 kind、text、confidence：
[{"kind":"profile","text":"一句话陈述","confidence":0.8}]

字段规则：
- kind 只能取 profile / preference / fact / todo 之一
- text 是完整的中文陈述句，脱离上下文也能读懂
- confidence 是 0 到 1 的小数
- 不要使用 content、category、title 等其他字段名

注意：同一批里常混着大量无用内容（构建日志、工具输出、一次性任务）。请**逐条判断**——只要有一条含可用信息就提取它，不要因为其他条无关而返回空数组。

示例输入：
[1] 我不用 Docker，机器上装不了
[2] 帮我看看这个报错
示例输出：
[{"kind":"profile","text":"用户不使用 Docker，且本机无法安装","confidence":0.85}]

没有可提取内容时，只输出：[]`;

const VALID_KINDS = new Set(['profile', 'preference', 'fact', 'todo', 'interest']);

const KIND_BY_CATEGORY = {
  工作环境: 'fact', 技术栈: 'fact', 部署环境: 'fact', 项目: 'fact', 环境: 'fact', 事实: 'fact',
  工作偏好: 'preference', 协作习惯: 'preference', 偏好: 'preference', 沟通偏好: 'preference', 习惯: 'preference',
  身份: 'profile', 职业: 'profile', 能力: 'profile', 画像: 'profile',
  待办: 'todo', 计划: 'todo', 事项: 'todo',
};

/** 模型有时会换成 content/category，这里统一收敛成 kind/text */
function normalizeCandidate(c) {
  if (!c || typeof c !== 'object') return null;
  let kind = String(c.kind || '').toLowerCase().trim();
  if (!VALID_KINDS.has(kind)) kind = KIND_BY_CATEGORY[String(c.category || '').trim()] || '';
  const text = String(c.text || c.content || c.statement || c.value || '').trim();
  if (!VALID_KINDS.has(kind)) {
    if (/偏好|习惯|希望|不要|喜欢|倾向|要求/.test(text)) kind = 'preference';
    else if (/待办|以后要|提醒|计划/.test(text)) kind = 'todo';
    else if (/我是|我在|职业|从事|技能|不懂|不会/.test(text)) kind = 'profile';
    else kind = 'fact';
  }
  const conf = typeof c.confidence === 'number' ? c.confidence
    : c.confidence === 'high' ? 0.85 : c.confidence === 'medium' ? 0.7 : c.confidence === 'low' ? 0.5 : 0.7;
  return { kind, text, confidence: conf };
}

function parseJsonArray(s) {
  const m = s.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/** 取最近 N 条用户发言（按文件修改时间取最近的会话，而不是按路径名） */
/**
 * 只取**某一个会话**的发言。
 *
 * 原实现（recentTurns）拿全局最近 12 个文件，多会话并行时会把别人的发言当成
 * 触发会话的内容去蒸馏：既串味，又让触发会话的计数被白白清零。
 */
export function sessionTurns(sessionId, { sessionsDir = null, fromSeq = 0, limit = 0 } = {}) {
  const dir = sessionsDir || path.join(os.homedir(), '.dsh', 'sessions');
  const id = String(sessionId || '');
  if (!id) return [];
  const files = walkSessions(dir)
    // 必须按目录名精确匹配：用 includes 会让 session-alpha 命中 session-alpha-extra
    .filter((f) => path.basename(path.dirname(f)) === id)
    .map((f) => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.m - b.m);
  if (!files.length) return [];
  let turns = collectUserTurns(files[files.length - 1].f);
  // 按序号过滤后再取**最早**的一批：积压超过单轮上限时不能丢掉最旧的那几条
  if (fromSeq > 0) turns = turns.filter((t) => Number(t.seq || 0) > fromSeq);
  return limit > 0 ? turns.slice(0, limit) : turns;
}

export function recentTurns(sessionsDir, n = 60) {
  const dir = sessionsDir || path.join(os.homedir(), '.dsh', 'sessions');
  const files = walkSessions(dir)
    .map((f) => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.m - b.m)
    .slice(-12)
    .map((x) => x.f);
  const all = [];
  for (const f of files) for (const t of collectUserTurns(f)) all.push(t);
  all.sort((a, b) => (a.time || 0) - (b.time || 0));
  return all.slice(-n);
}

/** 写入前统一去重（精确 + 近似 + 已拒绝抑制） */
/**
 * 分级准入：够格直接入库（active），拿不准才进 pending 队列。
 *
 * 设计理由：以前"一律 pending"等于把过滤工作全推给人，一天攒上百条，人不可能天天审。
 * 现在按"信息强度 + 类别 + 是否涉及替换"三件事判断，只有真拿不准的才需要人看。
 */
const HEDGE = /(可能|也许|大概|似乎|好像|或许|不确定|待定|存疑|据说|听说)/;
const STRONG = /(以后都|以后不|别再|不要再|一律|统一用|必须|记住|别忘|从现在开始)/;

export function shouldAutoAdmit({ kind, text, confidence, supersedes = null }) {
  const s = String(text || '').trim();
  const conf = Number(confidence) || 0;
  if (isHarnessNoise(s)) return false;              // 元配置噪声永不入库
  if (s.length < 10 || s.length > 200) return false;   // 太短信息不足，太长是总结，都留给人
  if (HEDGE.test(s)) return false;                     // 含糊措辞必须人工
  if (supersedes !== null) return false;               // 涉及替换旧条目：这是决策，人来定
  if (STRONG.test(s) && conf >= 0.72) return true;      // 用户明确指令句式
  if (['preference', 'profile', 'interest'].includes(kind) && conf >= 0.78) return true;
  // 事实门槛从 0.92 降到 0.82：模型给事实普遍打 0.85~0.9，0.92 等于全部拦下
  if (kind === 'fact' && conf >= 0.82) return true;
  if (kind === 'todo' && conf >= 0.85) return true;
  return false;
}

/**
 * 合并 pending 里的近重复：保留置信度最高的，其余转 rejected。
 * 用"词级包含度 + 去虚词"，因为改写类重复（"编译使用 X" / "编译通过 X 进行"）
 * 在字符层面差异很大，在词层面几乎同一集合。
 */
const DEDUPE_STOP = new Set(['用户', '的', '了', '是', '在', '和', '与', '也', '都', '就', '很', '有',
  '要求', '希望', '认为', '表示', '需要', '应该', '可以', '必须', '进行', '使用', '通过', '完成', '记住']);

export function dedupePendingMemories(db, { threshold = 0.8 } = {}) {
  const toks = (s) => new Set(segmentWords(s).map((w) => w.toLowerCase()).filter((w) => !DEDUPE_STOP.has(w)));
  const contain = (a, b) => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / Math.min(a.size, b.size);
  };
  const rows = db.prepare("SELECT id, text, confidence FROM memories WHERE status='pending' ORDER BY confidence DESC, id ASC").all();
  const kept = [];
  let dropped = 0;
  for (const r of rows) {
    const t = toks(r.text);
    const dup = kept.find((k) => contain(t, k.t) >= threshold);
    if (dup) {
      db.prepare("UPDATE memories SET status='rejected' WHERE id=?").run(r.id);
      journalAppend({ op: 'status', id: r.id, status: 'rejected', note: 'dedupe-pending #' + dup.id });
      dropped++;
      continue;
    }
    kept.push({ id: r.id, t });
  }
  return { kept: kept.length, dropped, threshold };
}

export function saveCandidates(db, cands, { limit = 30, source = 'llm', admit = true } = {}) {
  const existing = db.prepare("SELECT text FROM memories WHERE status IN ('pending','active','rejected')").all();
  const keys = new Set(existing.map((m) => dedupeKey(m.text)));
  const triList = existing.map((m) => ({ text: m.text, tri: toTrigrams(m.text) }));
  const added = [];
  for (const c of cands) {
    const text = normalize(String(c.text || ''));
    if (text.length < 8) continue;
    if (isHarnessNoise(text)) continue;   // 元配置噪声：换一次设置就产一条，无长期价值
    if (!['profile', 'preference', 'fact', 'todo', 'interest'].includes(c.kind)) continue;
    const k = dedupeKey(text);
    if (keys.has(k)) continue;
    const tri = toTrigrams(text);
    // 长度感知判重：短句更严、长句更松，长度差过大直接不判重
    if (triList.some((e) => isDuplicateText(text, e.text, tri, e.tri))) continue;
    keys.add(k); triList.push({ text, tri });
    const conf = Math.max(0, Math.min(1, Number(c.confidence) || 0.7));
    // 同主题但措辞不同的旧条目：只挂"拟替代"链接，确认时才真正替换
    const conflict = findConflict(db, { kind: c.kind, subject: c.subject || '', text });
    const sup = conflict ? conflict.row.id : null;
    // 和现有条目高度相似 = 同一件事的另一种说法，没有新信息，直接丢弃；
    // 只有中等相似（0.5~0.78）才是"要替换旧结论"，那种才值得人来定。
    if (conflict && conflict.sim >= 0.78) continue;
    const auto = admit && shouldAutoAdmit({ kind: c.kind, text, confidence: conf, supersedes: sup });
    const status = auto ? 'active' : 'pending';
    const now = nowIso();
    const r = db.prepare(`INSERT INTO memories(kind,subject,text,status,confidence,source,tags,created_at,supersedes_id,confirmed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(c.kind, c.subject || '', text, status, conf, source, auto ? 'auto,auto-admitted' : 'auto', now, sup, auto ? now : null);
    const id = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO memory_versions(memory_id,version,text,editor,note,created_at) VALUES(?,1,?,?,?,?)')
      .run(id, text, 'llm-distill', status, now);
    journalAppend({ op: 'put', id, kind: c.kind, subject: c.subject || '', text, status, confidence: conf, source, tags: auto ? 'auto,auto-admitted' : 'auto', created_at: now, supersedes_id: sup, detail: null, version: 1 });
    added.push({ id, kind: c.kind, text, confidence: conf, status, supersedes: sup, similarity: conflict ? conflict.sim : null });
    if (added.length >= limit) break;
  }
  return added;
}

/**
 * pending 队列维护：剔除与活跃记忆近重复的，按准入规则转正够格的。
 * 每轮蒸馏后自动跑，避免待确认队列无限堆积。
 */
export function maintainPending(db, { dupThreshold = 0.75 } = {}) {
  const pending = db.prepare("SELECT id, kind, text, confidence, supersedes_id, tags FROM memories WHERE status='pending'").all();
  if (!pending.length) return { admitted: 0, dropped: 0, remaining: 0 };

  const toks = (x) => new Set(segmentWords(x).map((w) => w.toLowerCase()).filter((w) => w.length >= 2));
  const active = db.prepare("SELECT id, kind, text FROM memories WHERE status='active'").all()
    .map((a) => ({ id: a.id, kind: a.kind, t: toks(a.text) }));

  const setStatus = db.prepare("UPDATE memories SET status=?, confirmed_at=? WHERE id=?");
  let admitted = 0;
  let dropped = 0;
  for (const r of pending) {
    // 挂了 supersedes_id 的是"拟替换旧结论"，必须留给人确认：
    // 判重会把它当重复拒掉，人就永远看不到这条新规则了。
    if (r.supersedes_id) continue;
    const rt = toks(r.text);
    let bestSim = 0;
    let bestId = 0;
    for (const a of active) {
      if (a.kind !== r.kind) continue;
      let inter = 0;
      for (const x of rt) if (a.t.has(x)) inter++;
      const sim = inter / Math.min(rt.size, a.t.size);
      if (sim > bestSim) { bestSim = sim; bestId = a.id; }
    }
    if (bestSim >= dupThreshold) {
      setStatus.run('rejected', null, r.id);
      journalAppend({ op: 'status', id: r.id, status: 'rejected', note: 'dup of active #' + bestId });
      dropped++;
      continue;
    }
    if (shouldAutoAdmit({ kind: r.kind, text: r.text, confidence: r.confidence, supersedes: r.supersedes_id ?? null })) {
      // 打标记才能被 auto-admitted / revoke-auto 审计与撤销
      const tags = r.tags ? (r.tags.includes('auto-admitted') ? r.tags : r.tags + ',auto-admitted') : 'auto,auto-admitted';
      db.prepare("UPDATE memories SET tags=? WHERE id=?").run(tags, r.id);
      setStatus.run('active', nowIso(), r.id);
      journalAppend({ op: 'status', id: r.id, status: 'active', tags, note: 'auto-admit' });
      admitted++;
    }
  }
  const remaining = db.prepare("SELECT COUNT(*) n FROM memories WHERE status='pending'").get().n;
  return { admitted, dropped, remaining };
}

/** 用 LLM 蒸馏一批发言 → 写 pending（分批调用，避免整批被判为噪声） */
export async function llmDistill(db, { turns, limit = 30, dryRun = false, batchSize = 15, admit = true } = {}) {
  const clean = (turns || []).filter((t) => {
    const s = String(t.text || '').trim();
    if (s.length < 6) return false;
    if (s.length > 1200) return false;
    return !/^(background job|pwsh-|node\.exe|--- \[|BUILD |started background job)/.test(s);
  });
  if (!clean.length) return { candidates: [], added: [], note: '过滤后没有可用发言' };

  const all = [];
  const seen = new Set();
  let failedBatches = 0;
  let lastError = '';
  let okTurns = 0;   // 连续成功处理的发言数（水位线只能推进到这里）
  for (let i = 0; i < clean.length; i += batchSize) {
    const batch = clean.slice(i, i + batchSize);
    const payload = batch.map((t, k) => `[${k + 1}] ${t.text}`).join('\n');
    let out = '';
    try {
      out = await chatWithRetry(
        [{ role: 'system', content: DISTILL_SYSTEM }, { role: 'user', content: payload }],
        { maxTokens: 4000, purpose: 'distill' },
        { retries: 2, baseDelayMs: 800 },
      );
    } catch (e) {
      // 一批失败就停：水位线只能推进到"连续成功"的位置。
      // 之前 continue 到下一批，会让"前 15 条成功、第 16 条失败"也把水位推到 16，
      // 第 16 条永远不再重试。
      failedBatches += 1;
      lastError = String(e.message || e);
      if (process.env.DEBUG_DISTILL) process.stderr.write('BATCH_ERR>>>' + lastError + '\n');
      break;
    }
    okTurns = i + batch.length;   // 本批整批处理完才算数
    if (process.env.DEBUG_DISTILL) {
      process.stderr.write(`RAW_LLM_OUTPUT[batch ${i / batchSize + 1}]>>>` + String(out).slice(0, 400) + '\n');
    }
    for (const c of parseJsonArray(out).map(normalizeCandidate)) {
      if (!c || c.text.length < 8) continue;
      const k = dedupeKey(c.text);
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(c);
    }
  }
  const batches = Math.ceil(clean.length / batchSize);
  // 预演也要能看出网关挂了：先把失败判断做完，再分支返回
  if (failedBatches > 0 && okTurns === 0) {
    throw new Error('蒸馏全部批次失败: ' + lastError);
  }
  if (dryRun) return { candidates: all, batches, okTurns, failedBatches, dryRun: true };
  return {
    candidates: all,
    added: saveCandidates(db, all, { limit, source: 'llm', admit }),
    batches, okTurns, failedBatches, failed: failedBatches > 0,
  };
}