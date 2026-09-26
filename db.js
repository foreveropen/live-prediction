// 数据库初始化 - better-sqlite3 同步API，事务简单可靠
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'yuyan.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  chips_balance INTEGER NOT NULL DEFAULT 1000,
  chips_frozen INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | active | sealed | settled | voided
  min_bet INTEGER NOT NULL DEFAULT 10,
  max_bet INTEGER NOT NULL DEFAULT 10000,
  seal_at INTEGER,           -- 封盘时间戳（毫秒）
  settled_side TEXT,         -- 结算结果 'A' | 'B'
  settled_at INTEGER,
  is_top INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  prediction_id INTEGER NOT NULL,
  side TEXT NOT NULL,        -- 'A' | 'B'
  amount INTEGER NOT NULL,
  profit INTEGER,            -- 结算时算出的盈利（负数表示输掉本金）
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, prediction_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(prediction_id) REFERENCES predictions(id)
);

CREATE TABLE IF NOT EXISTS chip_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,        -- register | bet_freeze | bet_win | bet_lose | void_refund | admin_adjust
  amount INTEGER NOT NULL,   -- 变动额（正负）
  balance_after INTEGER NOT NULL,
  frozen_after INTEGER NOT NULL,
  ref TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_config (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_bets_prediction ON bets(prediction_id);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_user ON chip_logs(user_id);
`);

// 默认房间配置
db.prepare(`INSERT OR IGNORE INTO room_config(key,value) VALUES('global_enabled','1')`).run();
db.prepare(`INSERT OR IGNORE INTO room_config(key,value) VALUES('need_fans','0')`).run();

module.exports = db;
