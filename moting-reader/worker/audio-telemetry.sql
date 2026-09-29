-- Recent listening sessions and playback events, with no book text or credentials.
-- Query remotely: SELECT * FROM audio_telemetry ORDER BY id DESC LIMIT 100;
CREATE TABLE IF NOT EXISTS audio_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  event TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_telemetry_session ON audio_telemetry (session_id, id);
CREATE INDEX IF NOT EXISTS idx_audio_telemetry_at ON audio_telemetry (at);
