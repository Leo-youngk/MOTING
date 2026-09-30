-- 只增加确认标识，保留原位置、时间和 server_at。先迁移，再发布 Worker。
ALTER TABLE positions ADD COLUMN mutation_id TEXT;
ALTER TABLE listening ADD COLUMN mutation_id TEXT;
