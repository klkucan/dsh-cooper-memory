// lib/db.mjs —— 唯一的库结构定义与连接入口
//
// 设计依据（来自 WeKnora 的实践，见 docs）：
//  - 分块被手工编辑后，字符偏移不可靠 → 主键语义用 (doc_id, ordinal) + version
//  - 分块编辑每次生成新版本，可回滚（02-knowledge-base.md:91）
//  - 记忆 pending 不注入，确认后 active；新事实替代旧事实（23-memory.md:13-32）
//  - 目录结构由 rel_path 派生，不建目录表（02-knowledge-base.md:395）

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = process.env.MEM_ROOT || path.join(os.homedir(), '.dsh-memory');
export const DB_PATH = process.env.MEM_DB || path.join(ROOT, 'mem.db');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY,
  rel_path    TEXT NOT NULL UNIQUE,
  abs_path    TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime       TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id             INTEGER PRIMARY KEY,
  doc_id         INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL,
  heading        TEXT NOT NULL DEFAULT '',
  context_header TEXT NOT NULL DEFAULT '',
  text           TEXT NOT NULL,
  tier           TEXT NOT NULL DEFAULT '',
  version        INTEGER NOT NULL DEFAULT 1,
  edited_at      TEXT,
  edited_by      TEXT,
  UNIQUE (doc_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id, ordinal);

-- 每次编辑 / 回滚都追加一行，chunks.version 指向当前生效版本
CREATE TABLE IF NOT EXISTS chunk_versions (
  id         INTEGER PRIMARY KEY,
  chunk_id   INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  text       TEXT NOT NULL,
  heading    TEXT NOT NULL DEFAULT '',
  editor     TEXT,
  note       TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (chunk_id, version)
);
CREATE INDEX IF NOT EXISTS idx_cv_chunk ON chunk_versions(chunk_id, version);

-- trigram 分词：中文无需词典即可子串召回
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5 (text, heading, tokenize='trigram');

-- 词元索引：jieba 词元 + CJK 二元组（unicode61 按空格切词），负责整词精确命中
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts_tokens USING fts5 (tokens, tokenize='unicode61');

-- 向量索引：bge-small-zh-v1.5 的 512 维句向量，int8 量化后存 BLOB（每块 512 字节）
-- 单独建表而不是给 chunks 加列，是为了让"没有向量"的分块不受影响（增量构建）
CREATE TABLE IF NOT EXISTS chunk_vectors (
  chunk_id   INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  dim        INTEGER NOT NULL,
  scale      REAL NOT NULL,
  vec        BLOB NOT NULL,
  model      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- 模块索引：给每个模块一句话摘要，检索命中时先看摘要，再决定展开哪块
-- 借鉴 Qoder 的 INDEX.md：总览 + 最后核对时间，比直接翻分块省 token
CREATE TABLE IF NOT EXISTS module_index (
  module_key   TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL DEFAULT '',
  doc_count    INTEGER NOT NULL DEFAULT 0,
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  model        TEXT,
  updated_at   TEXT NOT NULL
);

-- 触发器只在建库时创建；旧库的升级在 migrate() 里做一次（见 migrateTriggers）
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE rowid = old.id;
  DELETE FROM chunk_vectors WHERE chunk_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF text, heading ON chunks BEGIN
  DELETE FROM chunks_fts WHERE rowid = old.id;
  INSERT INTO chunks_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
  DELETE FROM chunk_vectors WHERE chunk_id = new.id;
END;

-- 记忆：profile/profile 偏好/fact/事项/兴趣 五类
CREATE TABLE IF NOT EXISTS memories (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,
  subject       TEXT NOT NULL DEFAULT '',
  text          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  confidence    REAL NOT NULL DEFAULT 0.6,
  source        TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  confirmed_at  TEXT,
  superseded_by INTEGER REFERENCES memories(id),
  version       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_mem_status ON memories(status, kind);

CREATE TABLE IF NOT EXISTS memory_versions (
  id         INTEGER PRIMARY KEY,
  memory_id  INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  text       TEXT NOT NULL,
  editor     TEXT,
  note       TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (memory_id, version)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- LLM 调用记账：蒸馏/探针每次调用一行，用于成本看板
CREATE TABLE IF NOT EXISTS llm_usage (
  id                INTEGER PRIMARY KEY,
  at                TEXT NOT NULL,
  purpose           TEXT NOT NULL DEFAULT '',
  provider          TEXT NOT NULL DEFAULT '',
  model             TEXT NOT NULL DEFAULT '',
  prompt_chars      INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  ok                INTEGER NOT NULL DEFAULT 1,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_at ON llm_usage(at);
`;

export function openDb(dbPath = DB_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** 增量迁移：老库补列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加列） */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name);
  if (!cols.includes('supersedes_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN supersedes_id INTEGER REFERENCES memories(id)');
  }
  // 导入型记忆需要完整正文：text 只存一行结论，detail 存原文
  if (!cols.includes('detail')) {
    db.exec('ALTER TABLE memories ADD COLUMN detail TEXT');
  }
  // 词元列（jieba 词元 + 二元组），供 FTS unicode61 索引
  const chunkCols = db.prepare('PRAGMA table_info(chunks)').all().map((c) => c.name);
  if (!chunkCols.includes('tokens')) {
    db.exec('ALTER TABLE chunks ADD COLUMN tokens TEXT');
  }
  migrateTriggers(db);
}

/**
 * 把旧库的分块触发器升级成"会清向量"的版本，**只做一次**。
 *
 * 早先直接在 schema 里写 DROP+CREATE：每次开库都执行 DDL，
 * schema_version 每次都涨，且遇到别的连接持有写事务会 database is locked。
 * 现在用 meta 里的标记判断是否已迁移，失败（锁）就跳过，下次开库再试。
 */
function migrateTriggers(db) {
  try {
    const done = db.prepare("SELECT value FROM meta WHERE key='triggers_v2'").get();
    if (done && String(done.value) === '1') return;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DROP TRIGGER IF EXISTS chunks_ai');
      db.exec('DROP TRIGGER IF EXISTS chunks_ad');
      db.exec('DROP TRIGGER IF EXISTS chunks_au');
      db.exec(`CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
      END`);
      db.exec(`CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
        DELETE FROM chunks_fts WHERE rowid = old.id;
        DELETE FROM chunk_vectors WHERE chunk_id = old.id;
      END`);
      db.exec(`CREATE TRIGGER chunks_au AFTER UPDATE OF text, heading ON chunks BEGIN
        DELETE FROM chunks_fts WHERE rowid = old.id;
        INSERT INTO chunks_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
        DELETE FROM chunk_vectors WHERE chunk_id = new.id;
      END`);
      db.prepare("INSERT INTO meta(key,value) VALUES('triggers_v2','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } catch (e) {
    // 数据库被别的连接写锁住：跳过本次迁移，不影响打开和读取
    if (!/locked|busy/i.test(String(e.message || e))) throw e;
  }
}

export const nowIso = () => new Date().toISOString();

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}

export function getMeta(db, key) {
  const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  return r ? r.value : null;
}