// lib/scenes.mjs —— L1 → L2 场景块
//
// 借鉴 dsh-prime-memory 的分层：L1 是零散事实，L2 把同一主题的多条事实压成
// 一篇"场景文档"。目的不是存更多，而是存得更少、更可读：
// 召回时先命中场景（一篇），需要细节再展开到具体记忆。
//
// 聚类不用 trigram 相似度——任务摘要措辞各不相同，相似度天然很低，
// 实测 1170 条只有 25 条能进簇。改用"共享特征词"：实体词权重 2，中文实词权重 1。

import { nowIso } from './db.mjs';
import { chat } from './llm.mjs';
import { tokenizeSync } from './tokenize.mjs';
import { distinctiveTerms, isKnowledgeQuestion } from './terms.mjs';

const SCENE_SYSTEM = `你是记忆整理器。输入是一组关于同一个主题的零散记忆条目。
请把它们合并成一篇紧凑的场景文档。

严格输出 JSON：
{"title":"不超过 20 字的中文标题","body":"正文"}

要求：
- body 用 Markdown 无序列表，3~8 条，每条一行，不超过 60 字
- 只使用输入里出现的信息，不得补充、推测或发挥
- 合并重复信息；相互矛盾的条目要在该条末尾标注"（存在冲突）"
- 不要输出总结性的套话，不要出现"这些记忆表明"之类的措辞`;

const toTrigrams = (s) => {
  const set = new Set();
  const t = String(s || '').toLowerCase().replace(/\s+/g, ' ');
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
 * 任务/过程类高频词：只说明"在做什么动作"，不说明"在讲哪个主题"。
 * 不过滤的话，一堆互不相关的任务会因为都含"知识库""修复"被聚成一簇。
 */
const PROCESS_WORDS = new Set([
  '知识库', '文档', '修复', '问题', '排查', '记录', '编写', '整理', '生成', '分析',
  '方案', '评估', '校准', '归档', '链路', '系统', '配置', '流程', '任务', '缺陷',
  '错误', '编译', '内存', '性能', '优化', '设计', '实现', '测试', '验证', '落地',
  '复盘', '沉淀', '规范', '说明', '支持', '增加', '新增', '修改', '调整', '更新',
  '诊断', '根因', '策略', '确认', '补充', '梳理', '构建', '注意', '避免', '建议',
  '流程化', '自动化', '工具', '脚本', '接口', '数据', '版本', '项目', '用户',
]);

const isEntityToken = (t) => /^[a-z][a-z0-9_.\-]{2,}$/.test(t);

/** 建表（幂等） */
export function ensureSceneTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scenes (
      id          INTEGER PRIMARY KEY,
      key         TEXT NOT NULL UNIQUE,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      memory_ids  TEXT NOT NULL,
      count       INTEGER NOT NULL DEFAULT 0,
      model       TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scenes_key ON scenes(key);
  `);
}

function topicCluster(list, { perClusterCap = 12, minSize = 3, minWeight = 3 } = {}) {
  const items = list.map((r) => {
    const all = tokenizeSync(r.text).split(' ');
    const keep = new Set();
    for (const t of all) {
      if (t.length < 2 || /^\d+$/.test(t)) continue;
      if (PROCESS_WORDS.has(t)) continue;
      if (isEntityToken(t)) { keep.add(t); continue; }
      if (/[\u4e00-\u9fff]/.test(t) && t.length >= 3) keep.add(t);
    }
    return { r, toks: keep };
  });

  const df = new Map();
  for (const it of items) for (const t of it.toks) df.set(t, (df.get(t) || 0) + 1);
  const common = new Set();
  const n = items.length;
  for (const [t, c] of df) if (c > Math.max(8, n * 0.06)) common.add(t);

  const weight = (t) => (isEntityToken(t) ? 2 : 1);

  const inv = new Map();
  items.forEach((it, i) => {
    for (const t of it.toks) {
      if (common.has(t)) continue;
      if (!inv.has(t)) inv.set(t, []);
      inv.get(t).push(i);
    }
  });

  const used = new Set();
  const groups = [];
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const seed = items[i];
    const rare = [...seed.toks].filter((t) => !common.has(t));
    if (!rare.length) continue;

    const overlap = new Map();
    for (const t of rare) {
      const w = weight(t);
      for (const j of inv.get(t) || []) {
        if (j === i || used.has(j)) continue;
        overlap.set(j, (overlap.get(j) || 0) + w);
      }
    }
    const ranked = [...overlap.entries()]
      .filter(([, w]) => w >= minWeight)
      .sort((a, b) => b[1] - a[1]);
    if (!ranked.length) continue;

    const members = [seed.r];
    const picked = [i];
    for (const [j] of ranked) {
      if (members.length >= perClusterCap) break;
      members.push(items[j].r);
      picked.push(j);
    }
    if (members.length < minSize) continue;
    picked.forEach((j) => used.add(j));
    groups.push(members);
  }
  return groups;
}

/**
 * 聚簇
 * @returns {Array<{key:string, label:string, members:Array<{id,text,subject}>}>}
 */
export function clusterMemories(db, { minSize = 3, maxClusters = 30, perClusterCap = 12, minWeight = 3 } = {}) {
  const rows = db.prepare(`
    SELECT id, kind, subject, text FROM memories
    WHERE status='active' AND kind IN ('fact','preference','profile')
    ORDER BY confidence DESC, id DESC`).all();

  const clusters = [];
  const used = new Set();

  // 1) 有 subject 的先分组；大组内部再按共享特征词细分
  const bySubject = new Map();
  for (const r of rows) {
    const s = (r.subject || '').trim();
    if (!s) continue;
    if (!bySubject.has(s)) bySubject.set(s, []);
    bySubject.get(s).push(r);
  }
  for (const [subject, list] of bySubject) {
    if (list.length < minSize) continue;
    if (list.length <= perClusterCap) {
      list.forEach((m) => used.add(m.id));
      clusters.push({ key: `subject:${subject}`, label: subject, members: list });
    } else {
      const parts = topicCluster(list, { perClusterCap, minSize, minWeight });
      parts.forEach((members, i) => {
        members.forEach((m) => used.add(m.id));
        clusters.push({ key: `subject:${subject}#${i + 1}`, label: `${subject}/${i + 1}`, members });
      });
    }
    if (clusters.length >= maxClusters) return clusters.slice(0, maxClusters);
  }

  // 2) 没有 subject 的同样按共享特征词聚
  const rest = rows.filter((r) => !used.has(r.id));
  if (rest.length) {
    const parts = topicCluster(rest, { perClusterCap, minSize, minWeight });
    parts.forEach((members, i) => {
      clusters.push({ key: `topic:${i + 1}`, label: `topic-${i + 1}`, members });
    });
  }
  return clusters.slice(0, maxClusters);
}

function parseScene(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (!o.title || !o.body) return null;
    return { title: String(o.title).slice(0, 60), body: String(o.body).trim() };
  } catch { return null; }
}

/** 生成单个场景文档（除非 dryRun，否则写库） */
export async function buildScene(db, cluster, { dryRun = false, model = null } = {}) {
  ensureSceneTable(db);
  const payload = cluster.members.map((m, i) => `${i + 1}. ${m.text}`).join('\n');
  const out = await chat(
    [{ role: 'system', content: SCENE_SYSTEM }, { role: 'user', content: payload }],
    { maxTokens: 2000, purpose: 'l2-scene', model },
  );
  const scene = parseScene(out);
  if (!scene) throw new Error('模型输出不是合法 JSON');

  const ids = cluster.members.map((m) => m.id);
  const row = {
    key: cluster.key,
    title: scene.title,
    body: scene.body,
    memory_ids: JSON.stringify(ids),
    count: ids.length,
    model,
    updated_at: nowIso(),
  };
  if (!dryRun) {
    db.prepare(`INSERT INTO scenes(key,title,body,memory_ids,count,model,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET title=excluded.title, body=excluded.body,
        memory_ids=excluded.memory_ids, count=excluded.count, model=excluded.model, updated_at=excluded.updated_at`)
      .run(row.key, row.title, row.body, row.memory_ids, row.count, row.model, nowIso(), row.updated_at);
  }
  return { ...row, dryRun };
}

export function listScenes(db, { limit = 50 } = {}) {
  ensureSceneTable(db);
  return db.prepare('SELECT id,key,title,count,updated_at FROM scenes ORDER BY count DESC, id DESC LIMIT ?').all(limit);
}

export function getScene(db, id) {
  ensureSceneTable(db);
  return db.prepare('SELECT * FROM scenes WHERE id=?').get(id);
}

/** 召回时补充命中的场景（按标题/正文词匹配） */
export function recallScenes(db, query, { limit = 2, minHit = 2 } = {}) {
  ensureSceneTable(db);
  // 和知识库同一个闸门：操作指令（"连接155的redis"）不该带出主题场景
  if (!isKnowledgeQuestion(query)) return [];
  // 用 jieba 词而不是正则切："如何创建一个新的商店NPC" 会被正则切成
  // 一个超长中文串，永远匹配不上；分词后是 [如何, 创建, 商店, npc]。
  // 用有判别力的词："新建/存在"这类高频词会把无关场景顶上来
  const terms = distinctiveTerms(db, query).filter((t) => t.length >= 2).slice(0, 10);
  if (terms.length < 2) return [];
  const rows = db.prepare('SELECT * FROM scenes').all();
  // 标题命中权重更高：场景标题是主题的浓缩，正文命中只算辅助
  const scored = rows.map((s) => {
    const title = String(s.title || '').toLowerCase();
    const hay = title + ' ' + String(s.body || '').toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 3;
      else if (hay.includes(t)) score += 1;
    }
    return { s, score };
  }).filter((x) => x.score >= 2).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ s }) => ({
    id: s.id, title: s.title, body: s.body, count: s.count, key: s.key,
  }));
}