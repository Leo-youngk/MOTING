-- 墨听云端同步的 D1 表结构。
-- updated_at: 客户端声明的修改时间，记录级 LWW 合并依据。
-- server_at:  服务端写入时间（毫秒*1000+序号），pull 的增量水位。
-- deleted_at: 墓碑。书和划线支持删除同步，其余类型只有 upsert。

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens (expires_at);

-- 单调递增的 server_at 号段分配器;key 固定为 server_clock。
CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  meta TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  server_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_books_server ON books (server_at);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  server_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notes_server ON notes (server_at);

CREATE TABLE IF NOT EXISTS positions (
  book_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  server_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_server ON positions (server_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  server_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_server ON sessions (server_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  server_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  book_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  server_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS patches (
  book_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  server_at INTEGER NOT NULL
);
