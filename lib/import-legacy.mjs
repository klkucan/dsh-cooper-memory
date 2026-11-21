// lib/import-legacy.mjs —— 把已有记忆库（Markdown + YAML frontmatter）导入本地记忆库
//
// 每条节点是 Markdown + YAML frontmatter，正文按固定的几段结构组织：
//   # 功能名：xxx      ← 一行结论，作为我们的 text
//   # 生效条件 / # 执行  ← 细节，作为 detail
// 分类靠 tags 里的 `cat:*`，项目靠 `proj:*`。
//
// 映射规则（宁可归到 fact，也不要乱猜成 preference，因为 preference 是常驻注入的）：
//   user_behavior / user_communication / 偏好类 → preference
//   项目介绍 / 架构 / 技术栈 / 环境 / 构建 / IDE / SCM / 依赖 → fact
//   经验类（task_summary / pitfalls / decision / skill / tool / mcp） → fact
//   structural（审核裁决记录） → 跳过，那是审计不是记忆

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nowIso } from './db.mjs';
import { dedupeKey, isDuplicateText } from './extract.mjs';
import { append as journalAppend } from './journal.mjs';

const DEFAULT_DIR = path.join(os.homedir(), '.dsh', '.dsh-memory', 'data', 'mdcg');

const PREF_CATS = new Set([
  'cat:user_behavior', 'cat:user_communication', 'cat:preference', 'cat:user_preference',
]);
const SKIP_CATS = new Set(['cat:audit', 'cat:review-record', 'cat:audit_trace']);

/** 极简 frontmatter 解析：只取需要的字段 */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    meta[mm[1]] = v;
  }
  return { meta, body: m[2] };
}

function parseTags(raw) {
  return (raw || '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** 从 CCG 正文里取一行结论 */
function extractTitle(body, fallback) {
  const m = body.match(/^#\s*功能名[：:]\s*(.+)$/m);
  if (m) return m[1].trim();
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return fallback;
}

export function parseLegacyNode(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  const tags = parseTags(meta.tags);
  const cats = tags.filter((t) => t.startsWith('cat:'));
  const proj = tags.find((t) => t.startsWith('proj:'));
  const id = meta.id || path.basename(file, '.md');
  const title = extractTitle(body, id);
  let kind = 'fact';
  if (cats.some((c) => PREF_CATS.has(c))) kind = 'preference';
  return {
    id,
    layer: meta.layer || '',
    lifecycle: (meta.lifecycle_state || 'active').trim(),
    importance: Number(meta.importance) || 0.6,
    confidence: Number(meta.confidence) || 0.6,
    sensitivity: meta.sensitivity || 'internal',
    createdAt: Number(meta.created_at) || 0,
    tags,
    cats,
    subject: proj ? proj.slice(5) : (meta.layer === 'contextual' ? '' : ''),
    kind,
    title,
    body: body.trim(),
    skip: cats.some((c) => SKIP_CATS.has(c)) || tags.some((t) => ['audit', 'review-record', 'audit_trace'].includes(t)),
    file,
  };
}

/**
 * @param {object} db
 * @param {{dir?:string, dryRun?:boolean, limit?:number, layers?:string[]}} opts
 */
export function importLegacy(db, opts = {}) {
  const dir = opts.dir || DEFAULT_DIR;
  const layers = opts.layers || ['knowledge', 'contextual'];
  const dryRun = !!opts.dryRun;
  const limit = opts.limit ?? 5000;

  const existing = db.prepare("SELECT text FROM memories WHERE status IN ('pending','active','rejected')").all();
  const keys = new Set(existing.map((m) => dedupeKey(m.text)));
  const tris = existing.map((m) => ({ text: m.text, tri: toTri(m.text) }));

  const stats = { files: 0, imported: 0, skipped: 0, dup: 0, byKind: {}, byLayer: {}, errors: [] };
  const samples = [];
  const insert = db.prepare(`INSERT INTO memories(kind,subject,text,status,confidence,source,tags,created_at,confirmed_at,detail)
    VALUES(?,?,?,'active',?,?,?,?,?,?)`);

  for (const layer of layers) {
    const layerDir = path.join(dir, layer);
    for (const file of walk(layerDir)) {
      if (stats.imported + stats.dup >= limit) break;
      stats.files++;
      try {
        const node = parseLegacyNode(file);
        if (node.skip) { stats.skipped++; continue; }
        if (node.lifecycle !== 'active') { stats.skipped++; continue; }
        const text = node.title.slice(0, 240);
        if (text.length < 4) { stats.skipped++; continue; }
        const key = dedupeKey(text);
        const tri = toTri(text);
        if (keys.has(key) || tris.some((e) => isDuplicateText(text, e.text, tri, e.tri))) {
          stats.dup++; continue;
        }
        keys.add(key); tris.push({ text, tri });
        stats.byKind[node.kind] = (stats.byKind[node.kind] || 0) + 1;
        stats.byLayer[layer] = (stats.byLayer[layer] || 0) + 1;
        if (samples.length < 8) samples.push({ kind: node.kind, subject: node.subject, text: text.slice(0, 60), tags: node.tags.slice(0, 3) });
        if (dryRun) { stats.imported++; continue; }
        const r = insert.run(
          node.kind,
          node.subject,
          text,
          Math.max(0, Math.min(1, node.importance || node.confidence)),
          `legacy:${layer}:${node.id}`,
          ['legacy', ...node.tags].join(','),
          nowIso(),
          nowIso(),
          node.body,
        );
        journalAppend({
          op: 'put', id: Number(r.lastInsertRowid), kind: node.kind, subject: node.subject, text,
          status: 'active', confidence: Math.max(0, Math.min(1, node.importance || node.confidence)),
          source: `legacy:${layer}:${node.id}`, tags: ['legacy', ...node.tags].join(','),
          created_at: nowIso(), supersedes_id: null, detail: node.body, version: 1,
        });
        stats.imported++;
      } catch (e) {
        stats.errors.push({ file: path.basename(file), error: String(e.message || e) });
      }
    }
  }
  return { ...stats, samples, dryRun };
}

const toTri = (s) => {
  const set = new Set();
  const t = s.toLowerCase().replace(/\s+/g, ' ');
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
};