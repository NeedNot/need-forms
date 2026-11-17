-- Forms, and the submissions we keep forever.
-- Per-form options that are not filtered in SQL live in settings_json
-- (for example {"subject":"Hello from {{name}}"}) so new settings do not need a column.

CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY,
  destination_email TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  submitter_email TEXT,
  -- pending: waiting to send. sending: claimed. sent / failed / spam: terminal for delivery.
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'spam')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  next_attempt_at TEXT,
  sent_at TEXT,
  claimed_at TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (form_id) REFERENCES forms (id)
);

CREATE INDEX IF NOT EXISTS idx_submissions_status_due
  ON submissions (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_submissions_status_claimed
  ON submissions (status, claimed_at);

CREATE INDEX IF NOT EXISTS idx_submissions_form_created
  ON submissions (form_id, created_at);
