// lib/journal.mjs —— 记忆事件的只增日志（JSONL）
//
// 借鉴 dsh-prime-memory 的"双写"：SQLite 是检索用的派生视图，JSONL 是事实源。
// 区别在于**范围**：只有记忆是不可再生的（文档/分块能从源文件重建），
// 所以日志只记记忆的增删改，重建也只重放记忆。
//
// 每条一行 JSON，最后一个事件胜出（last-write-wins）。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, nowIso } from './db.mjs';

export const JOURNAL_NAME = 'memories.journal.jsonl';

export function journalPath() {
  return process.env.MEM_JOURNAL || path.join(ROOT, JOURNAL_NAME);
}

export function journalEnabled() {
  return process.env.MEM_JOURNAL_OFF !== '1';
}

/** 追加一条事件；失败只告警，绝不阻塞主流程（对齐"降级不阻塞宿主"） */
export function append(ev) {
  if (!journalEnabled()) return;
  try {
    const p = journalPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ t: nowIso(), ...ev }) + '\n', 'utf8');
  } catch (e) {
    if (process.env.MEM_DEBUG) process.stderr.write('[journal] append failed: ' + e.message + '\n');
  }
}

export function stats() {
  const p = journalPath();
  if (!fs.existsSync(p)) return { path: p, exists: false, events: 0, bytes: 0 };
  const st = fs.statSync(p);
  let events = 0;
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(1 << 20);
    let pos = 0;
    let n;
    // 仅用于统计，按块读、数换行
    while ((n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
      for (let i = 0; i < n; i++) if (buf[i] === 10) events++;
      pos += n;
    }
    fs.closeSync(fd);
  } catch { /* ignore */ }
  return { path: p, exists: true, events, bytes: st.size };
}

/**
 * 从日志重建记忆表。
 * @param {object} db
 * @param {{dryRun?:boolean}} opts
 */
export function rebuild(db, { dryRun = false } = {}) {
  const p = journalPath();
  if (!fs.existsSync(p)) return { error: '日志不存在', path: p };

  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const state = new Map();
  const parseErrors = [];
  let skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    let ev;
    try { ev = JSON.parse(lines[i]); } catch { parseErrors.push(i + 1); continue; }
    const id = ev.id;
    if (!id) continue;
    const cur = state.get(id) || {};
    if (ev.op === 'put') {
      state.set(id, {
        id,
        kind: ev.kind, subject: ev.subject || '', text: ev.text,
        status: ev.status || 'pending', confidence: ev.confidence ?? 0.6,
        source: ev.source || '', tags: ev.tags || '',
        created_at: ev.created_at || ev.t, confirmed_at: ev.confirmed_at ?? null,
        supersedes_id: ev.supersedes_id ?? null,
        superseded_by: ev.superseded_by ?? null,
        detail: ev.detail ?? null,
        version: ev.version ?? 1,
      });
    } else if (ev.op === 'status') {
      // 目标不存在（日志截断/手工编辑遗留）时跳过：否则会造出没有正文的"幽灵条目"，
      // 重建时会以 undefined 绑定 SQL 参数直接失败。
      if (!state.has(id)) { skipped += 1; continue; }
      state.set(id, { ...cur, status: ev.status, ...(ev.confirmed_at ? { confirmed_at: ev.confirmed_at } : {}) });
      // 字段存在（哪怕值是 null）表示"这次要改"，缺字段表示"保持原值"
      if ('superseded_by' in ev) state.set(id, { ...state.get(id), superseded_by: ev.superseded_by ?? null });
      // 状态变化常伴随版本推进（拒绝会新增一版），必须一起重放
      if (ev.version != null) state.set(id, { ...state.get(id), version: ev.version });
      // 自动转正会追加标签，标签丢了就没法按标签审计或撤销
      if (ev.tags != null) state.set(id, { ...state.get(id), tags: ev.tags });
    } else if (ev.op === 'edit') {
      if (!state.has(id)) { skipped += 1; continue; }
      state.set(id, {
        ...cur,
        text: ev.text ?? cur.text,
        version: ev.version ?? cur.version,
        // 编辑会把 pending 提升为 active，这个状态变化必须一起重放，否则恢复后没法参与召回
        ...(ev.status ? { status: ev.status } : {}),
        ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
      });
    } else if (ev.op === 'delete') {
      state.delete(id);
    }
  }

  const out = {
    path: p, events: lines.length, parseErrors: parseErrors.slice(0, 5),
    memories: state.size, skipped, dryRun,
  };
  if (dryRun) return out;

  // 重建是"整表替换"，自引用外键（supersedes_id / superseded_by）在插入中途
  // 必然出现指向未插入行的窗口，因此临时关闭外键检查；外部一致性由日志顺序保证。
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM memories');
    const ins = db.prepare(`INSERT INTO memories(id,kind,subject,text,status,confidence,source,tags,created_at,confirmed_at,supersedes_id,detail,version,superseded_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insVer = db.prepare('INSERT OR IGNORE INTO memory_versions(memory_id,version,text,editor,note,created_at) VALUES(?,?,?,?,?,?)');
    const ordered = [...state.values()].sort((a, b) => a.id - b.id);
    for (const m of ordered) {
      ins.run(m.id, m.kind, m.subject, m.text, m.status, m.confidence, m.source, m.tags,
        m.created_at, m.confirmed_at, m.supersedes_id, m.detail, m.version ?? 1, m.superseded_by ?? null);
    }
    // 记忆版本（编辑历史）不在日志里，重建后只补一条当前版本，保证版本链可用
    for (const m of ordered) {
      insVer.run(m.id, m.version ?? 1, m.text, 'rebuild', 'from journal', m.created_at);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    db.exec('PRAGMA foreign_keys = ON');
    throw e;
  }
  db.exec('PRAGMA foreign_keys = ON');
  out.rebuilt = state.size;
  return out;
}