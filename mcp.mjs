#!/usr/bin/env node
// mcp.mjs —— stdio MCP 服务：DSH 通过子进程直接调用，不走任何网络
// 协议：JSON-RPC 2.0，stdin/stdout 每行一个消息（MCP stdio transport）
import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { openDb } from './lib/db.mjs';
import { warmup as warmupTokenizer } from './lib/tokenize.mjs';
import {
  ingestFolder, searchChunks, searchChunksHybrid, searchInteractive, getChunk, editChunk, chunkHistory,
  chunkVersionText, rollbackChunk, diffTexts, tree,
  remember, confirmMemory, rejectMemory, editMemory, listMemories, recall,
} from './lib/core.mjs';
import { runAutoExtract, recentTurns, llmDistill } from './lib/extract.mjs';
import { probe as llmProbe } from './lib/llm.mjs';
import { recordUsage, setRecorder, usageSummary } from './lib/usage.mjs';
import { listScenes, getScene } from './lib/scenes.mjs';

const db = openDb();
setRecorder((r) => recordUsage(db, r));
// 启动即预热 jieba：不预热的话，本进程写入的 tokens 列退化成二元组，
// 与宿主/CLI 写入的索引口径不一致，检索质量会莫名变差
void warmupTokenizer().catch(() => {});
// 版本号以 package.json 为准，避免两处漂移（旧版写死 0.1.0）
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; }
})();
const SERVER = { name: 'dsh-cooper-memory', version: PKG_VERSION };
const PROTOCOL = '2024-11-05';

const TOOLS = [
  {
    name: 'memory_recall',
    description: '召回长期记忆（跨会话）。返回常驻资料/偏好 + 与本轮问题相关的事实/事项。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '当前问题，用于匹配事实类记忆' },
        budget_chars: { type: 'number', description: '字符预算，默认 1200' },
      },
    },
  },
  {
    name: 'memory_remember',
    description: '写入一条记忆。status=pending 时不参与召回，需用户确认后生效。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['profile', 'preference', 'fact', 'todo', 'interest'] },
        text: { type: 'string' },
        subject: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'active'], description: '默认 pending' },
        confidence: { type: 'number' },
        tags: { type: 'string' },
        supersedes: { type: 'number', description: '要替代的旧记忆 id；省略则自动探测同主题旧条目' },
      },
      required: ['kind', 'text'],
    },
  },
  {
    name: 'memory_confirm',
    description: '确认一条待确认记忆，使其进入召回。',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'memory_reject',
    description: '拒绝一条记忆（保留抑制记录，不再召回）。',
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, note: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'memory_list',
    description: '列出记忆，可按状态/类别过滤。',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'number' } },
    },
  },
  {
    name: 'memory_edit',
    description: '编辑记忆正文（生成新版本）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' }, text: { type: 'string' }, note: { type: 'string' } },
      required: ['id', 'text'],
    },
  },
  {
    name: 'kb_search',
    description: '知识库检索。可传 variants 数组（查询改写结果），服务端会用加权 RRF 融合多路结果，并用 MMR 去冗余。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        variants: { type: 'array', items: { type: 'string' }, description: '同义改写/扩展查询' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kb_get',
    description: '读取单个分块全文。',
    inputSchema: { type: 'object', properties: { chunk_id: { type: 'number' } }, required: ['chunk_id'] },
  },
  {
    name: 'kb_edit',
    description: '编辑分块正文，生成新版本。base_version 用于乐观锁：与当前版本不一致时拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        chunk_id: { type: 'number' },
        text: { type: 'string' },
        note: { type: 'string' },
        base_version: { type: 'number' },
      },
      required: ['chunk_id', 'text'],
    },
  },
  {
    name: 'kb_history',
    description: '分块版本历史。',
    inputSchema: { type: 'object', properties: { chunk_id: { type: 'number' } }, required: ['chunk_id'] },
  },
  {
    name: 'kb_diff',
    description: '分块两版本逐行比对。',
    inputSchema: {
      type: 'object',
      properties: { chunk_id: { type: 'number' }, from: { type: 'number' }, to: { type: 'number' } },
      required: ['chunk_id', 'from'],
    },
  },
  {
    name: 'kb_rollback',
    description: '把分块回滚到指定版本（生成新版本，不删除历史）。',
    inputSchema: {
      type: 'object',
      properties: { chunk_id: { type: 'number' }, version: { type: 'number' } },
      required: ['chunk_id', 'version'],
    },
  },
  {
    name: 'kb_tree',
    description: '已入库文档的目录树（保留原始目录结构）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kb_ingest',
    description: '导入一个目录（递归，保留相对路径），按三层策略自动分块。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },

        prefix: { type: 'string', description: '命名空间前缀（导入多个根目录时必填，避免同名文件互相覆盖）' },
        chunk_size: { type: 'number' },
        chunk_overlap: { type: 'number' },
        strategy: { type: 'string', enum: ['auto', 'heading', 'heuristic', 'legacy'] },
      },
      required: ['path'],
    },
  },
  {
    name: 'memory_extract',
    description: '自动提取：扫描 DSH 会话日志，把检测到的偏好/事实/画像写成「待确认」记忆。水位线去重，重复调用不会重复写入。',
    inputSchema: {
      type: 'object',
      properties: {
        sessions_dir: { type: 'string', description: '默认 ~/.dsh/sessions' },
        limit: { type: 'number', description: '本轮最多新增条数，默认 30' },
        dry_run: { type: 'boolean', description: '只看候选、不落库' },
      },
    },
  },
{
    name: 'memory_probe_llm',
    description: '探测本服务进程能否调用 LLM。区分四种情况：config=没配置(缺 baseURL/model/key)、network=出网被拦、auth=凭据不对、ok=可用。用于决定走 LLM 蒸馏还是规则提取。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_distill',
    description: '用 LLM 蒸馏最近的用户发言，提取长期记忆并写入待确认队列（比规则提取准）。若探针返回 network/auth 失败，请改用 memory_extract 或直接 memory_remember。',
    inputSchema: {
      type: 'object',
      properties: {
        turns_limit: { type: 'number', description: '取最近多少条用户发言，默认 60' },
        limit: { type: 'number', description: '最多写入条数，默认 30' },
        dry_run: { type: 'boolean' },
        sessions_dir: { type: 'string' },
      },
    },
  },
{
    name: 'memory_scenes',
    description: '列出 L2 场景块（多个同主题记忆压缩成的文档），按覆盖条数排序。',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'memory_scene',
    description: '读取单个场景块全文（含它覆盖的记忆 id）。',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'memory_usage',
    description: 'LLM 调用成本：按模型/日期/用途聚合的 token 用量。不传参数返回近 30 天汇总。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '回看天数，默认 30' },
        purpose: { type: 'string', description: '只统计某用途，如 distill' },
      },
    },
  },
];

async function callTool(name, a = {}) {
  switch (name) {
    case 'memory_recall': return recall(db, a.query || '', { budgetChars: a.budget_chars || 1200 });
    case 'memory_remember': return remember(db, {
      kind: a.kind, text: a.text, subject: a.subject || '',
      status: a.status || 'pending', confidence: a.confidence ?? 0.6, source: 'mcp',
      supersedes: a.supersedes ?? null,
    });
    case 'memory_confirm': return confirmMemory(db, Number(a.id));
    case 'memory_reject': return rejectMemory(db, Number(a.id), { note: a.note || '' });
    case 'memory_list': return listMemories(db, { status: a.status || null, kind: a.kind || null, limit: a.limit || 100 });
    case 'memory_edit': return editMemory(db, Number(a.id), a.text, { note: a.note || '' });
    case 'kb_search': {
      const r = await searchInteractive(db, { query: a.query, variants: a.variants || [], limit: a.limit || 8 });
      return {
        fused: r.fused,
        results: r.results.map((x) => ({
          chunk_id: x.id, path: x.rel_path, ordinal: x.ordinal,
          score: Number(x.score.toFixed(4)), heading: x.heading, text: x.text,
          module: x.module || null,
        })),
      };
    }
    case 'kb_get': return getChunk(db, Number(a.chunk_id));
    case 'kb_edit': return editChunk(db, Number(a.chunk_id), a.text, {
      note: a.note || '', baseVersion: a.base_version ?? null,
    });
    case 'kb_history': return chunkHistory(db, Number(a.chunk_id));
    case 'kb_diff': {
      const va = chunkVersionText(db, Number(a.chunk_id), Number(a.from));
      const vb = a.to ? chunkVersionText(db, Number(a.chunk_id), Number(a.to)) : getChunk(db, Number(a.chunk_id));
      if (!va || !vb) throw new Error('版本不存在');
      return diffTexts(va.text, vb.text);
    }
    case 'kb_rollback': return rollbackChunk(db, Number(a.chunk_id), Number(a.version));
    case 'kb_tree': return { tree: tree(db) };
    case 'kb_ingest': return ingestFolder(db, a.path, {
      chunk_size: a.chunk_size ?? 512,
      chunk_overlap: a.chunk_overlap ?? 80,
      strategy: a.strategy || 'auto',
      prefix: a.prefix || undefined,
    });
    case 'memory_extract': return runAutoExtract(db, {
      sessionsDir: a.sessions_dir || undefined,
      limit: a.limit ?? 30,
      dryRun: !!a.dry_run,
    });
    case 'memory_probe_llm': return await llmProbe();
    case 'memory_usage': return usageSummary(db, { days: a.days ?? 30, purpose: a.purpose || null });
    case 'memory_scenes': return listScenes(db, { limit: a.limit ?? 50 });
    case 'memory_scene': return getScene(db, Number(a.id)) || { error: 'not found' };
    case 'memory_distill': {
      const turns = Array.isArray(a.turns) && a.turns.length
        ? a.turns.map((t) => (typeof t === 'string' ? { text: t } : t))
        : recentTurns(a.sessions_dir || undefined, a.turns_limit ?? 60);
      if (!turns.length) return { candidates: [], added: [], note: '没有可蒸馏的用户发言' };
      return await llmDistill(db, { turns, limit: a.limit ?? 30, dryRun: !!a.dry_run });
    }
    default: throw new Error(`unknown tool: ${name}`);
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(req) {
  const { id, method, params } = req;
  if (method === undefined) return; // notification
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER,
        },
      });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      try {
        const data = await callTool(name, args || {});
        send({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] },
        });
      } catch (e) {
        send({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: 'ERROR: ' + (e.message || e) }], isError: true },
        });
      }
      return;
    }
    if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let queue = Promise.resolve();
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let req;
  try { req = JSON.parse(s); } catch { return; }
  const run = async () => { if (Array.isArray(req)) { for (const r of req) await handle(r); } else await handle(req); };
  queue = queue.then(run).catch(() => {});
});
process.on('SIGINT', () => process.exit(0));