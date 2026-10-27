CREATE TABLE IF NOT EXISTS calculator_submissions (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_calculator_submissions_status
  ON calculator_submissions(status, created_at);
