// index.js —— 原生 Cordis Host 插件：在 agent/pre-step 自动注入记忆
//
// 与 MCP 形态的分工：
//   - 本文件（Host 插件）：每步自动召回并注入，用户不用开口"回忆"
//   - mcp.mjs（MCP 服务）：暴露 20 个工具给模型主动调用
// 两者共用同一个 mem.db。
//
// 注入协议（对齐 dsh-prime-memory 的官方范式）：
//   ctx.on('agent/pre-step', async (payload, next) => { const d = await next(); ... })
//   返回 { kind:'enter', messages:[注入消息, ...d.messages] } 即把注入排在用户新消息之前。
//   注册时 prepend: true，先拿到下游决策再改写，不劫持其他监听器。

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, ROOT, getMeta, setMeta } from './lib/db.mjs';
import { recall, recallKb, recallKbAsync } from './lib/core.mjs';
import { recordUsage, setRecorder } from './lib/usage.mjs';
import { llmDistill, sessionTurns, dedupePendingMemories, maintainPending } from './lib/extract.mjs';
import { warmup as warmupTokenizer } from './lib/tokenize.mjs';
import { isKnowledgeQuestion } from './lib/terms.mjs';
import { getProfileBlock, profileNeedsRefresh, buildProfile } from './lib/profile.mjs';

export const name = 'dsh-cooper-memory';

const DEFAULTS = {
  enabled: true,
  budgetChars: 1000,   // 注入内容的总字符预算
  maxItems: 6,        // 最多注入多少条记忆
  maxScenes: 1,
  minScore: 0,        // 预留：召回分数下限
  dedupe: true,       // 同会话已注入的不再重复注入
  // goal 轮次是同一任务的自动延续，注入相关记忆有益无害；
  // 若不想让自动化轮次带记忆，设 false。
  injectOnGoal: true,
  // 把 Web 界面挂在宿主进程里：只要 DSH 在跑，http://127.0.0.1:17890 就在。
  // 0 = 不启动（想自己用 dsh-cooper-memory-web 单独跑时设 0）。
  webPort: 17890,
  // L3 常驻画像：把 profile/preference/interest 压成一段固定文本，每轮注入
  l3: { enabled: true, maxChars: 300 },
  // 知识库召回：让模型在看代码之前先看到相关文档
  kb: { enabled: true, maxChunks: 2, budgetChars: 420 },
  // 自动蒸馏：借鉴 dsh-prime-memory 的三段触发
  //   ① 会话攒够阈值（渐进 1→2→4→6）→ 立刻跑
  //   ② 静默 idleSeconds → 兜底落袋
  //   ③ 失败指数退避，避免卡在坏会话上反复烧 token
  autoDistill: {
    enabled: true,
    steadyThreshold: Number(process.env.MEM_AUTODISTILL_STEADY || 6),
    idleSeconds: Number(process.env.MEM_AUTODISTILL_IDLE || 300),
    tickMs: Number(process.env.MEM_AUTODISTILL_TICK_MS || 30000),
    maxTurnsPerRun: 30,
    minGapMs: 60000,        // 全局最小间隔，防多会话同时触发
    backoffMaxMs: 600000,
    // 分级准入：够格直接入库，只有拿不准的才进 pending 队列
    admit: true,
    // 每轮蒸馏后把 pending 里的近重复合并掉（保留置信度最高的）
    dedupePending: true,
  },
};

/** 哪些来源算"值得注入的一轮" */
const INJECTABLE_KINDS = new Set(['user', 'goal']);

const log = (ctx, level, msg) => {
  try { ctx?.logger?.[level]?.(msg); } catch { /* 日志失败忽略 */ }
};

// 注入轨迹：宿主日志通道不总是可达，落盘一份便于排查（只记结果与计数，不记正文）
const TRACE_MAX_BYTES = 2 * 1024 * 1024;
function trace(msg) {
  try {
    const p = path.join(ROOT, 'inject-trace.log');
    if (fs.existsSync(p) && fs.statSync(p).size > TRACE_MAX_BYTES) fs.renameSync(p, p + '.1');
    fs.appendFileSync(p, `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch { /* 轨迹失败不影响注入 */ }
}

// @deepseek-ai/dsh-llm 是 DSH 自带包，宿主能解析、我们包目录里不能。
// 所以运行时按需导入；拿不到就退化为手工构造同形消息（字段与官方一致）。
let factoryPromise = null;
function getUserMessageFactory() {
  if (factoryPromise) return factoryPromise;
  factoryPromise = (async () => {
    try {
      const mod = await import('@deepseek-ai/dsh-llm');
      if (typeof mod.createUserMessage === 'function') return mod.createUserMessage;
    } catch { /* 走兜底 */ }
    return ({ content, source }) => ({
      id: randomUUID(),
      role: 'user',
      content,
      source,
      createdAt: Date.now(),
    });
  })();
  return factoryPromise;
}

/** 用户消息判定：显式 plugin:* 之外都当作真实用户输入 */
function isUserishMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.role && m.role !== 'user') return false;
  const kind = m.source?.kind;
  if (!kind) return true;              // 无 source 的消息按用户输入处理（其它插件注入都会署名）
  if (kind === 'user') return true;
  return !String(kind).startsWith('plugin:');
}

/** 从消息数组里取最后一条用户文本 */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isUserishMessage(m)) continue;
    if (typeof m.content === 'string') return m.content.trim();
    if (Array.isArray(m.content)) {
      const t = m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
      if (t) return t;
    }
  }
  return '';
}

/** 诊断：把消息来源种类记进轨迹，便于判断判定条件是否符合真实形态 */
function sourceKinds(messages) {
  if (!Array.isArray(messages)) return 'none';
  return messages.map((m) => m?.source?.kind ?? (m?.role || '?')).slice(-6).join(',');
}

/** 把召回结果压成一段紧凑文本 */
/**
 * 组装注入文本。
 * @returns {{text: string, shown: {items:number[], scenes:number[], kb:number[]}}}
 *   shown 是**实际渲染进文本**的 id —— 去重只能标记这些，
 *   否则被 maxItems / 预算裁掉的条目会被误标成"已注入"，本会话再也不补。
 */
export function formatInjection(result, cfg, profileText = '') {
  const head = '<relevant-memories>\n以下是长期记忆里与本轮相关的条目，仅供参考，不代表当前任务状态：\n\n';
  const tail = '\n</relevant-memories>';
  const budget = Math.max(400, cfg.budgetChars);
  let room = budget - head.length - tail.length;
  const shown = { items: [], scenes: [], kb: [] };

  // 优先级：画像 > 记忆 > 知识库 > 场景。
  const MEMORY_CAP = Math.min(380, Math.floor(room * 0.40));
  const take = (text, cap, reserve = MEMORY_CAP) => {
    const t = String(text || '').slice(0, Math.max(0, Math.min(cap, room - reserve)));
    if (!t) return '';
    room -= t.length;
    return t;
  };

  const parts = [];

  if (profileText) {
    const cap = Math.min(cfg.l3?.maxChars ?? 220, 220);
    let prof = String(profileText);
    if (prof.length > cap) {
      const cut = prof.slice(0, cap);
      const idx = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'));
      prof = idx > cap * 0.6 ? cut.slice(0, idx + 1) : cut;
    }
    parts.push(take(`【用户画像】\n${prof}\n`, cap + 8));
  }

  // 记忆：逐条累加，放不下就停（记下实际放进去了哪几条）
  const memLines = [];
  let memLen = 0;
  // 遍历全部候选、按"已展示条数"计数：前面 6 条太长的场景下，第 7 条短的也要能展示
  for (const m of result.items) {
    if (shown.items.length >= cfg.maxItems) break;
    const tag = m.kind === 'preference' ? '偏好' : m.kind === 'profile' ? '画像' : m.kind === 'todo' ? '待办' : '事实';
    const line = `- [${tag}] ${m.text}`;
    if (memLen + line.length + 1 > MEMORY_CAP) continue;   // 跳过放不下的，继续试后面的短条目
    memLines.push(line);
    memLen += line.length + 1;
    shown.items.push(m.id);
  }
  if (memLines.length) {
    const block = take(memLines.join('\n'), MEMORY_CAP, 0);
    if (block) parts.push(block);
  }

  const kb = result.kb || [];
  if (kb.length) {
    const kbHead = '【知识库片段】（从本地文档库检索，若与本轮问题相关先据此作答，再决定是否翻代码；与代码冲突以代码为准）\n';
    const cap = Math.min(cfg.kb?.budgetChars ?? 300, 300);
    let block = kbHead;
    let used = kbHead.length;            // 引导头也算额度，否则最后一块会被尾部截断
    for (const h of kb) {
      const line = `— ${h.path}#${h.ordinal}${h.module ? `｜${h.module}` : ''}\n`;
      const roomLeft = Math.min(cap, room) - used - line.length;
      if (roomLeft < 60) break;
      const body = String(h.text || '').replace(/\s+/g, ' ').trim().slice(0, Math.min(110, roomLeft));
      block += line + body + '\n';
      used += line.length + body.length + 1;
      shown.kb.push(h.chunk_id);
    }
    if (shown.kb.length) {
      const got = take(block, cap, 0);
      if (got) parts.push(got);
    }
  }

  // 场景：整块放得下才给，绝不切半句
  for (const s of (result.scenes || []).slice(0, cfg.maxScenes)) {
    let block = `【场景·${s.title}】\n`;
    for (const l of String(s.body).split('\n').filter(Boolean).slice(0, 6)) block += l + '\n';
    if (block.length > Math.min(240, room)) continue;      // 放不下就整块跳过
    const got = take(block, block.length, 0);
    if (got) { parts.push(got); shown.scenes.push(s.id); }
  }

  const body = parts.filter(Boolean).join('\n');
  return { text: body ? head + body + tail : '', shown };
}

/**
 * Cordis Host 插件入口
 * @param {object} ctx Cordis 上下文
 * @param {object} config 来自 patch 的行配置
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (!cfg.enabled) return;

  const db = openDb();
  setRecorder((r) => recordUsage(db, r));
  // 预热点分词：归并与准入都要用词级比较，不预热会退化成二元组
  void warmupTokenizer().catch(() => {});
  ctx.effect(() => () => { try { db.close(); } catch { /* 已关闭 */ } });

  // Web 界面随宿主启动；端口占用只告警，绝不影响注入
  if (cfg.webPort) {
    ctx.effect(() => {
      let server = null;
      let disposed = false;
      import('./web.mjs')
        .then((m) => {
          if (disposed) return;
          server = m.startWeb({ port: Number(cfg.webPort), quiet: true });
          server.on('error', (e) => {
            const code = e?.code || '';
            trace(`web error ${code}: ${e?.message || e}`);
            log(ctx, 'warn', `[cooper-memory] Web 界面启动失败（${code}），注入不受影响`);
          });
          server.on('listening', () => trace(`web listening http://127.0.0.1:${cfg.webPort}`));
        })
        .catch((e) => {
          trace(`web import failed: ${e?.message || e}`);
          log(ctx, 'warn', `[cooper-memory] Web 界面加载失败：${e?.message || e}`);
        });
      return () => {
        disposed = true;
        try { server?.close(); } catch { /* 已关闭 */ }
      };
    });
  }

  // 同会话去重：会话 id → 已注入的记忆 id 集合
  const injected = new Map();
  // 多轮查询历史：会话 id → 最近 3 轮用户文本
  const queryHistory = new Map();
  // 画像注入记录：会话 id → 已注入的画像签名（画像稳定，一个会话只给一次，变了再给）
  const sentProfileSig = new Map();
  // 压缩检测：contextFoldSeq 变化说明上下文被折叠/压缩过，消息已不在模型上下文里，
  // 此时必须清掉去重记录，否则这些记忆整个会话都无法再注入。
  const foldedSeq = new Map();
  const sessionKeyOf = (payload) => String(payload?.agent?.session?.id ?? payload?.agent?.id ?? '');
  let shapeLogged = false;
  const dumpShape = (payload, decision) => {
    if (shapeLogged) return;
    shapeLogged = true;
    try {
      const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).join('|') : typeof o);
      trace(`shape payload=[${keys(payload)}] decision=[${keys(decision)}] kind=${decision?.kind}`);
      // 二级：常见容器的键名与长度
      for (const [label, v] of [
        ['payload.messages', payload?.messages],
        ['decision.messages', decision?.messages],
        ['payload.agent.frozenMessages', payload?.agent?.frozenMessages],
        ['payload.turn', payload?.turn],
        ['payload.step', payload?.step],
        ['payload.agent.session', payload?.agent?.session],
        ['payload.agent.systemPrompt', payload?.agent?.systemPrompt],
        ['payload.agent.inbox', payload?.agent?.inbox],
      ]) {
        if (v === undefined) { trace(`  ${label}=undefined`); continue; }
        if (Array.isArray(v)) {
          const kinds = v.slice(-4).map((m) => m?.source?.kind ?? m?.role ?? '?').join(',');
          trace(`  ${label}=array(${v.length}) last=[${kinds}]`);
          continue;
        }
        if (typeof v === 'object') { trace(`  ${label}=obj[${keys(v)}]`); continue; }
        trace(`  ${label}=${typeof v}:${String(v).slice(0, 40)}`);
      }
    } catch { /* 诊断失败忽略 */ }
  };

  // ── 自动蒸馏控制器（借鉴 prime-memory 的三段触发） ──
  const ad = cfg.autoDistill || {};
  const distillState = new Map(); // sessionId → {pending,lastAt,warmup,backoffUntil,failures}
  let distillRunning = false;
  let profileRefreshing = false;
  let lastRunAt = 0;

  const adState = (k) => {
    let s = distillState.get(k);
    if (!s) {
      s = { pending: 0, lastAt: Date.now(), warmup: 1, backoffUntil: 0, failures: 0 };
      distillState.set(k, s);
    }
    return s;
  };

  async function distillTick() {
    if (!ad.enabled || distillRunning) return;
    const now = Date.now();
    if (now - lastRunAt < (ad.minGapMs ?? 60000)) return;

    const idleMs = (ad.idleSeconds ?? 300) * 1000;
    let target = null;
    let reason = '';
    for (const [sid, s] of distillState) {
      if (s.pending <= 0 || now < s.backoffUntil) continue;
      const threshold = s.warmup > 0 ? Math.min(s.warmup, ad.steadyThreshold) : ad.steadyThreshold;
      if (s.pending >= threshold) { target = sid; reason = `threshold ${s.pending}/${threshold}`; break; }
      if (idleMs > 0 && now - s.lastAt >= idleMs) {
        target = sid;
        reason = `idle ${Math.round((now - s.lastAt) / 1000)}s`;
        break;
      }
    }
    if (!target) return;

    const s = distillState.get(target);
    distillRunning = true;
    lastRunAt = now;
    trace(`autodistill start session=${target} ${reason}`);
    try {
      // 只蒸馏**触发会话自己**的发言。多会话并行时用全局最近发言会串味，
      // 而且会让触发会话的计数被白白清零。
      const wmKey = `distill_wm:${target}`;
      const watermark = Number(getMeta(db, wmKey) || 0);
      // 只处理触发会话自己的发言。**绝不回退到全局**：目标会话没有日志时，
      // 回退会把别的会话的发言读进来（串味 + 水位错乱），此时应当什么都不做。
      const maxTurns = ad.maxTurnsPerRun ?? 30;
      const turns = sessionTurns(target, { fromSeq: watermark, limit: maxTurns });
      if (!turns.length) {
        s.pending = 0;
        trace(`autodistill skip no-new-turns session=${target} wm=${watermark}`);
        return;
      }
      const r = await llmDistill(db, { turns, limit: 20, dryRun: false, admit: ad.admit !== false });
      const added = r.added?.length ?? 0;
      // 水位只能推进到"连续成功处理"的最后一条：
      // 部分批次失败时，失败那条及其后的发言要留给下一轮重试。
      const okList = turns.slice(0, r.okTurns ?? turns.length);
      const lastSeq = okList.length ? Math.max(...okList.map((t) => Number(t.seq || 0))) : watermark;
      if (lastSeq > watermark) setMeta(db, wmKey, lastSeq);
      if (r.failed) {
        // 部分成功：不重置失败计数，保持 pending 让下一轮继续处理剩余发言
        s.failures += 1;
        s.backoffUntil = Date.now() + 30000;
        trace(`autodistill partial okTurns=${r.okTurns ?? 0}/${turns.length} wm=${lastSeq}`);
      }

      const admitted = (r.added || []).filter((x) => x.status === 'active').length;
      if (ad.dedupePending !== false) {
        try {
          const dd = dedupePendingMemories(db, { threshold: 0.8 });
          const mp = maintainPending(db);
          if (mp.admitted || mp.dropped) trace(`autodistill maintain admitted=${mp.admitted} dropped=${mp.dropped} pending=${mp.remaining}`);
          if (dd.dropped) trace(`autodistill dedupe dropped=${dd.dropped} kept=${dd.kept}`);
        } catch { /* 归并失败不影响本轮 */ }
      }
      // 调用期间可能又来了新发言：还有积压就别清零，让下一轮继续处理
      // 画像到期就顺手重建（文档承诺的"7 天强制刷新"得有人在宿主里执行）
      if (cfg.l3?.enabled !== false && !profileRefreshing && profileNeedsRefresh(db)) {
        profileRefreshing = true;
        try {
          await buildProfile(db, { maxChars: cfg.l3?.maxChars ?? 400 });
          sentProfileSig.clear();          // 让下一个会话重新注入新画像
          trace('profile refreshed (stale)');
        } catch (e) {
          trace(`profile refresh failed ${e?.message || e}`);
        } finally { profileRefreshing = false; }
      }
      const backlog = sessionTurns(target, { fromSeq: lastSeq, limit: 1 });
      s.pending = backlog.length ? 1 : 0;
      if (!r.failed) {
        s.failures = 0;
        s.backoffUntil = 0;
      }
      // 渐进阈值：成功一次就翻倍，达到稳态即毕业（0 = 稳态）
      s.warmup = s.warmup > 0 ? (s.warmup * 2 >= ad.steadyThreshold ? 0 : s.warmup * 2) : 0;
      trace(`autodistill ok added=${added} admitted=${admitted} candidates=${r.candidates?.length ?? 0} nextThreshold=${s.warmup || ad.steadyThreshold}`);
      log(ctx, 'info', `[cooper-memory] 自动蒸馏 +${added} 条（其中直接入库 ${admitted}），待确认归并后剩余更少（${reason}）`);
    } catch (e) {
      s.failures += 1;
      const backoff = Math.min(ad.backoffMaxMs ?? 600000, 30000 * 2 ** (s.failures - 1));
      s.backoffUntil = Date.now() + backoff;
      trace(`autodistill fail ${e?.message || e} backoff=${Math.round(backoff / 1000)}s`);
    } finally {
      distillRunning = false;
    }
  }

  if (ad.enabled) {
    ctx.effect(() => {
      const ms = Math.max(500, Number(ad.tickMs) || 30000);
      const timer = setInterval(() => { void distillTick(); }, ms);
      return () => clearInterval(timer);
    });
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    dumpShape(payload, decision);
    try {
      if (!decision || decision.kind !== 'enter') { trace(`skip kind=${decision?.kind}`); return decision; }
      if (payload?.signal?.aborted) { trace('skip aborted'); return decision; }
      if (!Array.isArray(decision.messages) || !decision.messages.length) { trace(`skip no-messages payloadMsgs=${Array.isArray(payload?.messages) ? payload.messages.length : 'na'}`); return decision; }

      // 只在本步携带"新的用户消息"时注入，纯工具步不重复注入
      const hasNewUser = decision.messages.some((m) => {
        if (!isUserishMessage(m)) return false;
        const kind = m.source?.kind;
        if (!kind) return true;
        if (kind === 'goal') return cfg.injectOnGoal !== false;
        return INJECTABLE_KINDS.has(kind);
      });
      if (!hasNewUser) { trace(`skip no-new-user kinds=${sourceKinds(decision.messages)}`); return decision; }

      // 本轮消息优先：payload.messages 在部分宿主版本里仍包含上一轮内容，
// 用它判意图会把上一轮的提问意图带进来
      const query = lastUserText(decision.messages) || lastUserText(payload.messages);
      if (!query || query.length < 2) { trace('skip empty-query'); return decision; }

      const sid = sessionKeyOf(payload);

      // 多轮查询：只用首条消息会让话题转移后的召回失效，这里保留最近 3 轮拼接
      const hist = queryHistory.get(sid) || [];
      if (hist[hist.length - 1] !== query) hist.push(query);
      const recent = hist.slice(-3);
      queryHistory.set(sid, recent);
      const searchQuery = recent.join(' ');

      // 累计待蒸馏轮次（自动蒸馏的计数来源）
      if (ad.enabled) {
        const st = adState(sid);
        st.pending += 1;
        st.lastAt = Date.now();
      }

      // 知识提问才查库：用"本轮自己的用户消息"判断，不用最近三轮拼接的查询。
      // 否则上一轮问了业务问题，这一轮的操作指令会继承提问意图，带进无关文档。
      const intentQuery = query;
      const result = recall(db, searchQuery, { budgetChars: cfg.budgetChars, withScenes: true, intentQuery });
      result.kb = (cfg.kb?.enabled === false || !isKnowledgeQuestion(intentQuery))
        ? []
        : await recallKbAsync(db, intentQuery, { limit: cfg.kb?.maxChunks ?? 2 });

      // 画像：稳定层，按签名每会话只注入一次（变了才重发）
      const prof = cfg.l3?.enabled === false ? { text: '', sig: null } : getProfileBlock(db);
      const profileText = prof.text && sentProfileSig.get(sid) !== prof.sig ? prof.text : '';

      // 判空必须包含 kb：画像发过之后，一个纯知识问题只会命中知识块，
      // 漏掉会把整轮注入丢掉（新用户最容易踩）。
      if (!result.items?.length && !result.scenes?.length && !result.kb?.length && !profileText) {
        trace(`skip no-hits q="${query.slice(0, 24)}"`);
        return decision;
      }

      // 去重（含压缩后重置）
      const key = sessionKeyOf(payload);
      const seq = Number(payload?.agent?.session?.contextFoldSeq ?? -1);
      const prevSeq = foldedSeq.get(key);
      if (prevSeq !== undefined && seq !== prevSeq) {
        injected.delete(key);
        queryHistory.delete(key);
        trace(`reset dedupe after compact session=${key} seq ${prevSeq}->${seq}`);
      }
      if (Number.isFinite(seq)) foldedSeq.set(key, seq);

      let seen = injected.get(key);
      if (!seen) { seen = new Set(); injected.set(key, seen); }
      let fresh = result;
      if (cfg.dedupe) {
        const items = (result.items || []).filter((m) => !seen.has(`m${m.id}`));
        const scenes = (result.scenes || []).filter((s) => !seen.has(`s${s.id}`));
        // 知识库块同样去重：注入过的块在本会话不再重复注入
        // （此前只对记忆去重，同一个文档块会每轮重新注入一遍，白烧 token）
        const kb = (result.kb || []).filter((k) => !seen.has(`k${k.chunk_id}`));
        fresh = { ...result, items, scenes, kb };
        if (!items.length && !scenes.length && !kb.length && !profileText) { trace('skip all-deduped'); return decision; }
      }

      const { text, shown } = formatInjection(fresh, cfg, profileText);
      if (!text) return decision;
      if (profileText) sentProfileSig.set(sid, prof.sig);

      const createUserMessage = await getUserMessageFactory();
      const injection = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin:cooper-memory', form: 'recall' },
      });

      // 只标记**真正渲染进文本**的条目：被 maxItems / 预算裁掉的下一轮还能补上
      if (cfg.dedupe) {
        for (const id of shown.items) seen.add(`m${id}`);
        for (const id of shown.scenes) seen.add(`s${id}`);
        for (const id of shown.kb) seen.add(`k${id}`);
      }
      log(ctx, 'info', `[cooper-memory] 注入 ${shown.items.length} 条记忆 / ${shown.scenes.length} 个场景 / ${shown.kb.length} 块文档（session=${key}）`);
      trace(`inject items=${shown.items.length} scenes=${shown.scenes.length} kb=${shown.kb.length} chars=${text.length} session=${key} q="${query.slice(0, 24)}"`);

      return { kind: 'enter', messages: [injection, ...decision.messages] };
    } catch (err) {
      // 注入失败绝不能阻断对话
      log(ctx, 'warn', `[cooper-memory] 注入失败，跳过本轮：${err?.message || err}`);
      trace(`error ${err?.message || err}`);
      return decision;
    }
  }, { prepend: true });
}