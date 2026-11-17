-- Drop the claim/lease columns. Retries now live on the delivery queue.
-- Rows left in `sending` become pending with no next_attempt_at so the hourly
-- cron can enqueue them.

PRAGMA defer_foreign_keys = on;

CREATE TABLE submissions_v2 (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  submitter_email TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'spam')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  next_attempt_at TEXT,
  sent_at TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (form_id) REFERENCES forms (id)
);

INSERT INTO submissions_v2 (
  id,
  form_id,
  payload_json,
  submitter_email,
  status,
  attempt_count,
  last_error,
  next_attempt_at,
  sent_at,
  message_id,
  created_at
)
SELECT
  id,
  form_id,
  payload_json,
  submitter_email,
  CASE WHEN status = 'sending' THEN 'pending' ELSE status END,
  attempt_count,
  last_error,
  CASE WHEN status = 'sending' THEN NULL ELSE next_attempt_at END,
  sent_at,
  message_id,
  created_at
FROM submissions;

DROP TABLE submissions;

ALTER TABLE submissions_v2 RENAME TO submissions;

CREATE INDEX IF NOT EXISTS idx_submissions_status_due
  ON submissions (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_submissions_form_created
  ON submissions (form_id, created_at);
