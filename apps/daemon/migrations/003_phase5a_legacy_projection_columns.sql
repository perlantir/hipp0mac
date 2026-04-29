ALTER TABLE tool_executions ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1));
ALTER TABLE tool_executions ADD COLUMN task_id TEXT;
ALTER TABLE tool_executions ADD COLUMN intended_event_id TEXT;
ALTER TABLE tool_executions ADD COLUMN result_event_id TEXT;
ALTER TABLE tool_executions ADD COLUMN lock_event_id TEXT;

ALTER TABLE tool_events ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1));
ALTER TABLE file_operation_logs ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1));

UPDATE tool_executions SET legacy = 1 WHERE intended_event_id IS NULL AND result_event_id IS NULL;
UPDATE tool_events SET legacy = 1;
UPDATE file_operation_logs SET legacy = 1;

CREATE INDEX IF NOT EXISTS idx_tool_executions_task_id ON tool_executions(task_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_intended_event_id ON tool_executions(intended_event_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_result_event_id ON tool_executions(result_event_id);
