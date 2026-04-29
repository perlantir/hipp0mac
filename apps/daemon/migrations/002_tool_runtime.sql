CREATE TABLE IF NOT EXISTS tool_executions (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_code TEXT,
  error_message TEXT,
  raw_output_ref TEXT,
  replay_json TEXT NOT NULL,
  approval_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_executions_tool_name ON tool_executions(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_executions_status ON tool_executions(status);
CREATE INDEX IF NOT EXISTS idx_tool_executions_created_at ON tool_executions(created_at);

CREATE TABLE IF NOT EXISTS tool_events (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES tool_executions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_events_execution_id ON tool_events(execution_id);
CREATE INDEX IF NOT EXISTS idx_tool_events_created_at ON tool_events(created_at);

CREATE TABLE IF NOT EXISTS tool_approvals (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES tool_executions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  input_json TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_approvals_execution_id ON tool_approvals(execution_id);
CREATE INDEX IF NOT EXISTS idx_tool_approvals_status ON tool_approvals(status);

CREATE TABLE IF NOT EXISTS file_operation_logs (
  id TEXT PRIMARY KEY,
  execution_id TEXT,
  operation TEXT NOT NULL,
  primary_path TEXT NOT NULL,
  secondary_path TEXT,
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  approval_required INTEGER NOT NULL CHECK (approval_required IN (0, 1)),
  reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_operation_logs_execution_id ON file_operation_logs(execution_id);
CREATE INDEX IF NOT EXISTS idx_file_operation_logs_operation ON file_operation_logs(operation);
CREATE INDEX IF NOT EXISTS idx_file_operation_logs_created_at ON file_operation_logs(created_at);

