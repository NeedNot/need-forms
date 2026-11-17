# Need Forms

A small self-hosted form endpoint. A page on any site can `POST` to this Cloudflare Worker. The Worker stores the submission in [D1](https://developers.cloudflare.com/d1/) first, then emails it with the [Email Service](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) `send_email` binding. If that send fails, the HTTP request still succeeds. A Cron Trigger later retries due rows with exponential backoff. Rows are kept forever for statistics: nothing in this Worker deletes them.

`database_id` in `wrangler.jsonc` is the existing D1 database `need-forms`. This repo does not deploy or apply migrations.

## Endpoint

`POST /submit/:formId`

`formId` is 1–64 characters, starting with a letter or digit, then letters, digits, `_`, or `-`. It must match a row in `forms`. An unknown id returns **404**.

| Content-Type | Body | Success response |
| --- | --- | --- |
| `application/json` | JSON object. Nested values are stored as JSON strings. | **200** `{"ok":true,"id":"<uuid>"}` |
| `application/x-www-form-urlencoded` | A normal HTML form | **303** to `redirect` when that field is a valid `http:` or `https:` URL, otherwise **200** HTML |
| `multipart/form-data` | A normal HTML form. File parts are rejected. | Same as urlencoded |

JSON callers always get JSON, even if the body includes `redirect`. Errors are always JSON: `{"ok":false,"error":"<code>"}`.

| Status | `error` | When |
| --- | --- | --- |
| 404 | `form_not_found` | Unknown or invalid form id |
| 400 | `invalid_json` | JSON body is not an object |
| 400 | `empty_submission` | No fields after control fields are removed |
| 400 | `too_many_fields` | More than 100 fields |
| 400 | `file_uploads_unsupported` | A multipart file part |
| 400 | `invalid_content_length` | `Content-Length` is not an integer |
| 405 | `method_not_allowed` | Not `POST` on `/submit/:formId` |
| 413 | `payload_too_large` | Body larger than `MAX_PAYLOAD_BYTES` (default 100000) |
| 415 | `unsupported_media_type` | Any other content type |
| 500 | `internal_error` | Unexpected failure while saving |

The success response means the row was saved. Delivery is queued after the insert. If the queue rejects the message, the response is still success and the row stays `pending` for the hourly safety net.

`OPTIONS` on any path returns **204** with:

```
access-control-allow-origin: *
access-control-allow-methods: POST, OPTIONS
access-control-allow-headers: Content-Type
```

Every response includes `access-control-allow-origin: *`, so a form hosted on another origin can post.

`GET /` returns a short plain-text check that the Worker is running.

### Control fields

| Field | Behavior |
| --- | --- |
| `math-sum` | Default honeypot. If this field is non-empty, the row is stored as `spam` and is not emailed or queued. The response looks like success. A form can override the field name with `settings_json.honeypot_field`. The honeypot field is never included in the email. |
| `redirect`, `_redirect` | HTML form posts only. After a successful save, **303** to that URL when it is `http:` or `https:` and at most 2000 characters. Anything else is ignored and the Worker returns the thank-you page. |

Other fields are the message. The first field whose name normalizes to `email` or `emailaddress` (`email`, `e-mail`, `email_address`, `emailAddress`) and looks like an email address is stored in `submitter_email` and used as the message's `replyTo`. It is also included in the body with the other fields.

The email has both a plain-text and an HTML body listing those fields, plus the form id, submission id, and `created_at`. The From address and display name come from `EMAIL_FROM` and `EMAIL_FROM_NAME`. The To address is the form's `destination_email`, read again at send time, so a correction to the form row applies to retries.

### Subject

`forms.settings_json` may contain `subject`. It can include `{{field_name}}` and `{{form_id}}`. Missing fields become empty. The default is `New form submission ({{form_id}})`.

```json
{"subject":"Contact from {{name}}","honeypot_field":"company"}
```

Omit `honeypot_field` to keep the default `math-sum`.

Add further per-form options as new keys in `settings_json` and read them in `parseSettings` (`src/fields.ts`). Use a migration only when a setting needs to be filtered in SQL.

## Schema

Timestamps are UTC ISO-8601 strings.

`migrations/0001_init.sql` created the original tables. `migrations/0002_drop_sending_claim.sql` removes the `sending` status and `claimed_at`. Apply `0002` before deploying this version. The schema after both migrations:

```sql
CREATE TABLE forms (
  id TEXT PRIMARY KEY,
  destination_email TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE submissions (
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
```

| Column | Role |
| --- | --- |
| `status` | `pending` (waiting on the queue), `sent`, `failed` (dead-lettered, row kept), `spam` (honeypot, never sent) |
| `attempt_count` | Incremented when a delivery attempt finishes, success or failure |
| `last_error` | Last send error, including the Email Service `code` when the binding provides one. Cleared on success |
| `next_attempt_at` | Set when the queue accepts the message, then moved to the next retry time after a failure. Null on a pending row means the enqueue never succeeded |
| `sent_at` | When the send was accepted |
| `message_id` | Email Service id, so a sent row can be matched to Email Service logs |
| `settings_json` | Per-form options. This Worker reads `subject` and `honeypot_field` |

D1 does not enforce the foreign key unless you turn foreign keys on. Do not `DELETE` from `submissions`. To count outcomes:

```sql
SELECT form_id, status, COUNT(*) AS n
FROM submissions
GROUP BY form_id, status;
```

Rows still waiting or stuck:

```sql
SELECT id, status, attempt_count, last_error, next_attempt_at, created_at
FROM submissions
WHERE status IN ('pending', 'failed')
ORDER BY created_at DESC;
```

## Delivery and retries

D1 is the permanent record. Cloudflare Queues does the sending.

1. Insert the row as `pending` with `next_attempt_at` null. Respond after that insert succeeds.
2. `env.DELIVERY_QUEUE.send({ submissionId })` to `need-forms-delivery`. On success, set `next_attempt_at` so the hourly cron will not enqueue it again. If the enqueue throws, the HTTP response is still success and `next_attempt_at` stays null.
3. The queue consumer skips a row that is already `sent`, `spam`, or `failed`, then acks.
4. Otherwise it sends the email. On success it sets `sent`, `sent_at`, `message_id`, increments `attempt_count`, and acks.
5. On send error it stores `last_error`, increments `attempt_count`, and calls `msg.retry({ delaySeconds })`. Delay is `RETRY_BASE_SECONDS * 2^(attempt-1)`, capped at `RETRY_MAX_SECONDS` (60s, then 120s, 240s, 480s, then one hour).
6. After `max_retries` (5) the message lands on `need-forms-delivery-dlq`. That consumer marks the row `failed`, keeps `last_error`, and acks.

The cron is `0 * * * *`. It only re-enqueues `pending` rows whose `next_attempt_at` is still null and whose `created_at` is more than 15 minutes ago. That covers an enqueue that failed. It does not send mail itself. Each run publishes at most 25 rows.

| Var | Default | Meaning |
| --- | --- | --- |
| `EMAIL_FROM` | `no-reply@forms.neednot.net` | From address. The domain must be onboarded to Email Sending |
| `EMAIL_FROM_NAME` | `Need Forms` | From display name |
| `RETRY_BASE_SECONDS` | `60` | First backoff |
| `RETRY_MAX_SECONDS` | `3600` | Backoff cap |
| `MAX_PAYLOAD_BYTES` | `100000` | Max request body. Enough for a long message, small enough to reject bulk junk |

`EMAIL_FROM` is `no-reply@forms.neednot.net`. Sends stay `pending` until that domain is onboarded to Email Sending.

Local `wrangler dev` simulates `send_email` and does not deliver. Logged mail is not sent. Add `"remote": true` on the `send_email` binding only when you want local code to send real messages.

## Setup

You need a Cloudflare account, a zone on Cloudflare DNS, and Email Sending enabled for that zone. Email Sending is an open beta and Cloudflare documents it as a Workers paid-plan feature. Node.js 22 or newer.

```bash
npm install
npx wrangler login
npx wrangler d1 migrations apply need-forms --remote
```

Onboard `forms.neednot.net` for Email Sending. The zone `neednot.net` has to be on the same Cloudflare account so the custom domain route can attach. Dashboard: **Compute** → **Email Service** → **Email Sending** → **Onboard Domain**. Or:

```bash
npx wrangler email sending enable forms.neednot.net
```

`EMAIL_FROM` and `EMAIL_FROM_NAME` are already set. Edit the destination in `seed/example.sql`, then load the example form (or use the insert in the next section):

```bash
npx wrangler d1 execute need-forms --remote --file=seed/example.sql
npx wrangler deploy
```

Deploy attaches the Worker to `forms.neednot.net`. Point forms at `https://forms.neednot.net/submit/<formId>`.

Nothing in this repository has been deployed, and the migrations have not been applied to D1.

## Add a form

```bash
npx wrangler d1 execute need-forms --remote --command "INSERT INTO forms (id, destination_email, settings_json, created_at) VALUES ('contact', 'you@example.com', '{\"subject\":\"New contact form submission\"}', '2026-01-01T00:00:00.000Z');"
```

Change an existing form, including a retry that has not been sent yet (the destination is read at send time):

```sql
UPDATE forms
SET destination_email = 'you@example.com',
    settings_json = '{"subject":"Contact from {{name}}"}'
WHERE id = 'contact';
```

Running `seed/example.sql` again updates the `contact` row's destination and settings.

## Example HTML form

Leave `math-sum` empty. Hide it off-screen with CSS. Do not use `type="hidden"`. Bots that fill every input are stored as spam and are not emailed.

```html
<form action="https://forms.neednot.net/submit/contact" method="POST">
  <input type="text" name="math-sum" autocomplete="off" tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px">
  <label>Name <input name="name" required></label>
  <label>Email <input name="email" type="email" required></label>
  <label>Message <textarea name="message" required></textarea></label>
  <input type="hidden" name="redirect" value="https://example.com/thanks">
  <button type="submit">Send</button>
</form>
```

JSON:

```bash
curl -X POST "https://forms.neednot.net/submit/contact" \
  -H "content-type: application/json" \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","message":"Hello"}'
```

## Local development

```bash
npm install
npx wrangler d1 migrations apply need-forms --local
npx wrangler d1 execute need-forms --local --file=seed/example.sql
npm run dev
```

`npm run dev` serves `http://127.0.0.1:43921`. The local database lives under `.wrangler/` and is not committed.

```bash
curl -X POST "http://127.0.0.1:43921/submit/contact" \
  -H "content-type: application/json" \
  -d '{"name":"Ada","email":"ada@example.com","message":"Hello"}'
```

Check the row:

```bash
npx wrangler d1 execute need-forms --local \
  --command "SELECT id, status, attempt_count, last_error, sent_at FROM submissions ORDER BY created_at DESC LIMIT 5;"
```

## Tests

```bash
npm test
npm run typecheck
```

Vitest runs inside the Workers runtime via `@cloudflare/vitest-plugin` (the current package that replaces `@cloudflare/vitest-pool-workers`). The suite covers a saved submission, a queue send that marks the row `sent`, a failed send left `pending` with backoff, the dead-letter path marking `failed`, the hourly re-enqueue, an unknown form **404**, and the honeypot. Most cases install a fake sender so failure is deterministic. One case calls the local `send_email` binding, which does not deliver mail.

After changing bindings or vars, run `npm run types` and commit the regenerated `worker-configuration.d.ts`.
