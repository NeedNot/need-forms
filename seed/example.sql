-- Example form. Edit the destination, then apply with:
--   npx wrangler d1 execute need-forms --remote --file=seed/example.sql
-- Re-running updates the same id.

INSERT INTO forms (id, destination_email, settings_json, created_at)
VALUES (
  'contact',
  'you@example.com',
  '{"subject":"New contact form submission"}',
  '2026-01-01T00:00:00.000Z'
)
ON CONFLICT (id) DO UPDATE SET
  destination_email = excluded.destination_email,
  settings_json = excluded.settings_json;
