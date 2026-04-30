CREATE TABLE IF NOT EXISTS strategy_effectiveness (
  failure_type TEXT NOT NULL,
  strategy TEXT NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (failure_type, strategy)
);

CREATE TABLE IF NOT EXISTS task_step_history (
  task_type TEXT PRIMARY KEY,
  mean REAL NOT NULL CHECK (mean >= 0),
  m2 REAL NOT NULL DEFAULT 0 CHECK (m2 >= 0),
  stddev REAL NOT NULL DEFAULT 0 CHECK (stddev >= 0),
  sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quality_reports (
  task_id TEXT PRIMARY KEY,
  project_id TEXT,
  completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
  overall_score REAL NOT NULL CHECK (overall_score >= 0 AND overall_score <= 1),
  report_json TEXT NOT NULL,
  artifact_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quality_reports_project_id ON quality_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_quality_reports_overall_score ON quality_reports(overall_score);
CREATE INDEX IF NOT EXISTS idx_quality_reports_created_at ON quality_reports(created_at);
