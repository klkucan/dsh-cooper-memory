// lib/merge.mjs —— 活跃记忆归并
//
// 背景：注入层的近重复去重只能"少显示几条"，库里仍是 8 个"兼容旧代码"变体，
// 每次查询都要在噪声里挑，且占用候选名额。
//
// 做法：按词包含度找近重复，**同 kind 内**合并，保留最长最具体的那条，
// 其余标 superseded 并指向保留者（保留审计链，可回滚）。

import fs from 'node:fs';
import path from 'node:path';
import { segmentWords } from './tokenize.mjs';
import { nowIso, ROOT } from './db.mjs';
import { append as journalAppend } from './journal.mjs';

const toksOf = (s) => new Set(segmentWords(s).map((w) => w.toLowerCase()).filter((w) => w.length >= 2));

/**
 * @param {{threshold?:number, dryRun?:boolean}} opts
 */
export function mergeDuplicateActive(db, { threshold = 0.65, dryRun = false } = {}) {
  const rows = db.prepare("SELECT id, kind, text, confidence, length(text) len FROM memories WHERE status='active'").all();
  // 长的优先当基准：信息更全
  const sorted = [...rows].sort((a, b) => b.len - a.len || (b.confidence || 0) - (a.confidence || 0));

  const keepers = [];          // { id, kind, toks, text }
  const merges = [];           // { id, into, text }
  for (const r of sorted) {
    const t = toksOf(r.text);
    if (!t.size) continue;
    let hit = null;
    for (const k of keepers) {
      if (k.kind !== r.kind) continue;          // 不同类别不合并，避免语义漂移
      let inter = 0;
      for (const x of t) if (k.toks.has(x)) inter++;
      if (inter / Math.min(t.size, k.toks.size) >= threshold) { hit = k; break; }
    }
    if (hit) merges.push({ id: r.id, into: hit.id, text: r.text });
    else keepers.push({ id: r.id, kind: r.kind, toks: t, text: r.text });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(ROOT, `merge-backup-${stamp}.json`);
  if (!dryRun) {
    fs.writeFileSync(backup, JSON.stringify({
      at: new Date().toISOString(), threshold,
      total: rows.length, kept: keepers.length, merged: merges.length,
      pairs: merges.map((m) => ({ id: m.id, into: m.into, text: m.text })),
    }, null, 2), 'utf8');

    const upd = db.prepare("UPDATE memories SET status='superseded', superseded_by=? WHERE id=?");
    db.exec('BEGIN');
    try {
      for (const m of merges) {
        upd.run(m.into, m.id);
        journalAppend({ op: 'status', id: m.id, status: 'superseded', superseded_by: m.into, note: `merged into #${m.into}` });
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  return {
    total: rows.length, kept: keepers.length, merged: merges.length,
    dryRun, backup: dryRun ? null : backup,
    samples: merges.slice(0, 8).map((m) => ({ id: m.id, into: m.into, text: m.text.slice(0, 40) })),
  };
}

/** 撤销归并：把 backup 里的 id 恢复为 active */
export function restoreMerge(db, backupFile) {
  const p = path.isAbsolute(backupFile) ? backupFile : path.join(ROOT, backupFile);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const upd = db.prepare("UPDATE memories SET status='active', superseded_by=NULL WHERE id=?");
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const m of data.pairs || []) {
      upd.run(m.id);
      // 显式带 null：journal 用「字段存在且为 null」表达"清空"，缺字段表示"不动"
      journalAppend({ op: 'status', id: m.id, status: 'active', superseded_by: null, note: 'restore-merge' });
      n++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { restored: n, from: p, at: nowIso() };
}