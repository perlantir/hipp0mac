ALTER TABLE tool_executions ADD COLUMN legacy INTEGER NOT NULL DEFAULT 1 CHECK (legacy IN (0, 1));
ALTER TABLE tool_executions ADD COLUMN intended_event_id TEXT;
ALTER TABLE tool_executions ADD COLUMN result_event_id TEXT;

ALTER TABLE tool_events ADD COLUMN legacy INTEGER NOT NULL DEFAULT 1 CHECK (legacy IN (0, 1));
ALTER TABLE tool_events ADD COLUMN canonical_event_id TEXT;

ALTER TABLE file_operation_logs ADD COLUMN legacy INTEGER NOT NULL DEFAULT 1 CHECK (legacy IN (0, 1));
ALTER TABLE file_operation_logs ADD COLUMN canonical_event_id TEXT;

