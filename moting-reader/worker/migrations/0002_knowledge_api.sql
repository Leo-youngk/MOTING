-- 独立的 Bot 只读密钥，不复用具有写权限的同步会话。
CREATE TABLE IF NOT EXISTS knowledge_api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_knowledge_api_keys_active ON knowledge_api_keys (revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_notes_book_server ON notes (book_id, server_at, id);
CREATE INDEX IF NOT EXISTS idx_chats_server ON chats (server_at, book_id);
