// lib/llm.mjs —— 给服务进程用的最小 LLM 客户端
//
// 配置只从本机读取，**不内置任何开发者默认地址 / 模型 / 凭据名**：
//   baseURL : LLM_BASE_URL | DEEPSEEK_BASE_URL  >  profile 里当前 provider 的 baseURL
//   model   : LLM_MODEL                         >  profile 里 agent-default-model 的 model
//   key     : LLM_KEY_ENV 指定的 env/凭据 ref    >  profile 里 provider 的 apiKeyEnv  >  DEEPSEEK_API_KEY
//
// 三项缺任何一项都直接报错，绝不回落到某个内置网关 —— 否则使用者的凭据会被发到与
// 他无关的上游。provider 由 agent-default-model.provider 决定；该 provider 找不到时
// 不会去猜别的 provider 的地址，而是按"缺少 baseURL"处理。
//
// 两个已知坑：
//   1. ~/.dsh/.credentials.yaml 是 flow mapping，值可能带尾随逗号或右花括号，必须剥掉
//   2. 推理模型的 max_tokens 太小会被 reasoning 吃光，content 返回空串

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emit as usageEmit } from './usage.mjs';

const FALLBACK_KEY_ENV = 'DEEPSEEK_API_KEY';

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

export function profilePatchPath() {
  const profile = process.env.DSH_PROFILE || 'desktop';
  return path.join(os.homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml');
}

const indentOf = (line) => line.match(/^ */)[0].length;

/** 取 startIdx 这一行下面、缩进更深的那一段（跳过空行与整行注释） */
function blockLines(lines, startIdx) {
  const baseIndent = indentOf(lines[startIdx]);
  const out = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { out.push(line); continue; }
    if (indentOf(line) <= baseIndent) break;
    out.push(line);
  }
  return out;
}

/** 在块内取 `key: value` 的标量值（去掉成对引号） */
function scalar(block, key) {
  const re = new RegExp('^\\s*' + key + ':\\s*(\\S.*?)\\s*$');
  for (const line of block) {
    const m = line.match(re);
    if (m) return m[1].replace(/^['"]|['"]$/g, '');
  }
  return '';
}

function firstScalar(lines, key) {
  const re = new RegExp('^\\s*' + key + ':\\s*(\\S.*?)\\s*$');
  for (const line of lines) {
    const m = line.match(re);
    if (m) return m[1].replace(/^['"]|['"]$/g, '');
  }
  return '';
}

/** providers: 下面的 name → 该 provider 的配置块 */
export function providerMap(lines) {
  const idx = lines.findIndex((l) => /^\s*providers:\s*$/.test(l));
  if (idx < 0) return {};
  const inner = blockLines(lines, idx);
  const entries = inner
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /^\s*[A-Za-z0-9_.-]+:\s*$/.test(line));
  if (!entries.length) return {};
  const baseIndent = Math.min(...entries.map(({ line }) => indentOf(line)));
  const tops = entries.filter(({ line }) => indentOf(line) === baseIndent);
  const map = {};
  tops.forEach(({ line, i }, k) => {
    const end = k + 1 < tops.length ? tops[k + 1].i : inner.length;
    map[line.trim().replace(/:\s*$/, '')] = inner.slice(i + 1, end);
  });
  return map;
}

/** 从 profile patch 里取 agent-default-model 与它指向的 provider 的 baseURL / apiKeyEnv */
export function readProviderConfig() {
  const yaml = readText(profilePatchPath());
  const out = { base: '', keyEnv: '', model: '', provider: '' };
  if (!yaml) return out;
  const lines = yaml.split(/\r?\n/);

  const idx = lines.findIndex((l) => /^\s*-?\s*id:\s*agent-default-model\s*$/.test(l));
  if (idx >= 0) {
    const block = blockLines(lines, idx);
    out.provider = scalar(block, 'provider');
    out.model = scalar(block, 'model');
  }

  const providers = providerMap(lines);
  const names = Object.keys(providers);
  const chosen = out.provider ? providers[out.provider] : null;
  if (chosen) {
    out.base = scalar(chosen, 'baseURL');
    out.keyEnv = scalar(chosen, 'apiKeyEnv');
    out.models = chosen
      .filter((l) => /^\s*-\s*id:/.test(l))
      .map((l) => l.replace(/^.*?-\s*id:\s*/, '').replace(/['"]/g, '').trim());
  } else if (!names.length) {
    // 旧版扁平写法：整个文件没有 providers 映射时，退回首个 baseURL / apiKeyEnv
    out.base = firstScalar(lines, 'baseURL');
    out.keyEnv = firstScalar(lines, 'apiKeyEnv');
  }
  // out.provider 存在但匹配不到 provider 时，base 保持为空 → 由 resolveConfig 报缺配置
  return out;
}

/**
 * 凭据：只解析调用方点名要的 ref，不把整个凭据文件读进内存对象。
 * refs 是 flow mapping，值可能带尾巴的逗号或右花括号。
 */
export function readCredentials(allow = []) {
  const yaml = readText(path.join(os.homedir(), '.dsh', '.credentials.yaml'));
  const want = new Set(allow.filter(Boolean));
  const refs = {};
  if (!yaml || !want.size) return refs;
  for (const line of yaml.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(\S+)\s*$/);
    if (!m || !want.has(m[1])) continue;
    refs[m[1]] = m[2].replace(/[,}]+$/, '');
  }
  return refs;
}

export function resolveConfig() {
  const prov = readProviderConfig();
  const keyEnv = process.env.LLM_KEY_ENV || prov.keyEnv || FALLBACK_KEY_ENV;
  const refs = readCredentials([keyEnv, FALLBACK_KEY_ENV]);

  let key = null;
  let usedKeyEnv = keyEnv;
  let keyFrom = 'none';
  if (process.env[keyEnv]) { key = process.env[keyEnv]; keyFrom = 'env'; }
  else if (refs[keyEnv]) { key = refs[keyEnv]; keyFrom = 'file'; }
  else if (refs[FALLBACK_KEY_ENV]) { key = refs[FALLBACK_KEY_ENV]; usedKeyEnv = FALLBACK_KEY_ENV; keyFrom = 'file'; }

  const base = (process.env.LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || prov.base || '').replace(/\/+$/, '');
  const model = process.env.LLM_MODEL || prov.model || '';

  const missing = [];
  if (!key) missing.push(`凭据 ${keyEnv}（环境变量或 ~/.dsh/.credentials.yaml 里的同名 ref）`);
  if (!base) missing.push('baseURL（profile 的 providers.<名字>.baseURL，或环境变量 LLM_BASE_URL）');
  if (!model) missing.push('model（profile 的 agent-default-model.model，或环境变量 LLM_MODEL）');

  return { key, base, model, provider: prov.provider || '', keyEnv: usedKeyEnv, keyFrom, missing, profilePath: profilePatchPath() };
}

const configError = (cfg) => '未配置 LLM：缺少 ' + cfg.missing.join('；');

/** 探测：只回答"这个进程能不能用 LLM"；返回里永远不含 key 本身 */
export async function probe({ timeoutMs = 30000 } = {}) {
  const cfg = resolveConfig();
  if (cfg.missing.length) {
    return {
      ok: false,
      stage: 'config',
      error: configError(cfg),
      missing: cfg.missing,
      base: cfg.base,
      model: cfg.model,
      keyFrom: cfg.keyFrom,
      profilePath: cfg.profilePath,
    };
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(cfg.base + '/chat/completions', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: '只回答两个字：可用' }],
        max_tokens: 64,
        stream: false,
      }),
    });
    const text = await r.text();
    if (r.ok) {
      let content = '';
      try { content = JSON.parse(text).choices?.[0]?.message?.content ?? ''; } catch {}
      return { ok: true, stage: 'ok', status: r.status, base: cfg.base, model: cfg.model, keyFrom: cfg.keyFrom, sample: content.slice(0, 40) };
    }
    if (r.status === 401 || r.status === 403) {
      return { ok: false, stage: 'auth', status: r.status, base: cfg.base, keyFrom: cfg.keyFrom, error: text.slice(0, 200) };
    }
    return { ok: false, stage: 'http', status: r.status, base: cfg.base, error: text.slice(0, 200) };
  } catch (e) {
    const code = e?.cause?.code || e?.name || 'unknown';
    return {
      ok: false, stage: 'network', code,
      error: code === 'EACCES' ? '出网被拦（沙箱/白名单）' : String(e.message || e),
      base: cfg.base, keyFrom: cfg.keyFrom,
    };
  } finally { clearTimeout(t); }
}

/** 一次非流式对话，返回文本 */
export async function chat(messages, { model, maxTokens = 3000, timeoutMs = 90000, temperature = 0, purpose = '' } = {}) {
  const cfg = resolveConfig();
  if (cfg.missing.length) throw new Error(configError(cfg));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  const promptChars = messages.reduce((n, m) => n + String(m.content || '').length, 0);
  const modelUsed = model || cfg.model;
  try {
    const r = await fetch(cfg.base + '/chat/completions', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({
        model: modelUsed,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
    });
    const raw = await r.text();
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${raw.slice(0, 300)}`);
    const j = JSON.parse(raw);
    const msg = j.choices?.[0]?.message ?? {};
    const u = j.usage || {};
    usageEmit({
      purpose, provider: cfg.provider || '', model: modelUsed,
      prompt_chars: promptChars,
      prompt_tokens: u.prompt_tokens ?? 0,
      completion_tokens: u.completion_tokens ?? 0,
      reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
      total_tokens: u.total_tokens ?? 0,
      duration_ms: Date.now() - t0, ok: true,
    });
    // 推理模型可能把额度全花在 reasoning 上
    if (!msg.content && msg.reasoning_content) throw new Error('模型只返回了 reasoning，没有正文；请调大 max_tokens');
    return msg.content ?? '';
  } catch (e) {
    usageEmit({
      purpose, provider: cfg.provider || '', model: modelUsed,
      prompt_chars: promptChars, duration_ms: Date.now() - t0,
      ok: false, error: String(e?.message || e).slice(0, 300),
    });
    const code = e?.cause?.code;
    if (code === 'EACCES') throw new Error('LLM 出网被拦（EACCES）：' + cfg.base);
    throw e;
  } finally { clearTimeout(t); }
}

/** 哪些失败值得重试：连接类错误与 429/5xx；鉴权错、参数错不重试 */
export function isTransient(err) {
  const m = String(err?.message || err || '');
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|fetch failed|HTTP 429|HTTP 5\d\d/i.test(m);
}

/**
 * 带指数退避的对话调用
 * @param {object} retry {retries, baseDelayMs, maxDelayMs}
 */
export async function chatWithRetry(messages, opts = {}, retry = {}) {
  const retries = retry.retries ?? 2;
  const baseDelayMs = retry.baseDelayMs ?? 800;
  const maxDelayMs = retry.maxDelayMs ?? 8000;
  let lastErr;
  const attempts = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = Date.now();
    try {
      const out = await chat(messages, opts);
      attempts.push({ attempt: attempt + 1, ms: Date.now() - t0, ok: true });
      if (process.env.DEBUG_DISTILL && attempt > 0) {
        process.stderr.write(`RETRY_OK>>>attempt ${attempt + 1} after ${attempts.length - 1} failures\n`);
      }
      return out;
    } catch (e) {
      lastErr = e;
      attempts.push({ attempt: attempt + 1, ms: Date.now() - t0, ok: false, error: String(e.message || e).slice(0, 120) });
      const canRetry = attempt < retries && isTransient(e);
      if (process.env.DEBUG_DISTILL) {
        process.stderr.write(`ATTEMPT ${attempt + 1} failed: ${String(e.message || e).slice(0, 120)} | retry=${canRetry}\n`);
      }
      if (!canRetry) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  const err = new Error(String(lastErr?.message || lastErr));
  err.attempts = attempts;
  throw err;
}
