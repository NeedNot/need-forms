# Form mail

A small self-hosted form endpoint. A page on any site can `POST` to this Cloudflare Worker. The Worker stores the submission in [D1](https://developers.cloudflare.com/d1/) first, then emails it with the [Email Service](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) `send_email` binding. If that send fails, the HTTP request still succeeds. A Cron Trigger later retries due rows with exponential backoff. Rows are kept forever for statistics: nothing in this Worker deletes them.

`database_id` in `wrangler.jsonc` is a placeholder. This repo does not create Cloudflare resources and does not deploy.

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

The success response means the row was saved, not that the email has already been accepted. The send runs after the response (`ctx.waitUntil`). A send failure is written onto the row and retried by cron.

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
| `_honeypot` | If non-empty, the row is stored as `spam` and is not emailed. The response looks like success. |
| `redirect`, `_redirect` | HTML form posts only. After a successful save, **303** to that URL when it is `http:` or `https:` and at most 2000 characters. Anything else is ignored and the Worker returns the thank-you page. |

Other fields are the message. The first field whose name normalizes to `email` or `emailaddress` (`email`, `e-mail`, `email_address`, `emailAddress`) and looks like an email address is stored in `submitter_email` and used as the message's `replyTo`. It is also included in the body with the other fields.

The email has both a plain-text and an HTML body listing those fields, plus the form id, submission id, and `created_at`. The From address and display name come from `EMAIL_FROM` and `EMAIL_FROM_NAME`. The To address is the form's `destination_email`, read again at send time, so a correction to the form row applies to retries.

### Subject

`forms.settings_json` may contain `subject`. It can include `{{field_name}}` and `{{form_id}}`. Missing fields become empty. The default is `New form submission ({{form_id}})`.

```json
{"subject":"Contact from {{name}}"}
```

Add further per-form options as new keys in `settings_json` and read them in `parseSettings` (`src/fields.ts`). Use a migration only when a setting needs to be filtered in SQL.

## Schema

Source of truth: `migrations/0001_init.sql`. Timestamps are UTC ISO-8601 strings.

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
```

| Column | Role |
| --- | --- |
| `status` | `pending` (due when `next_attempt_at` is null or in the past), `sending` (claimed), `sent`, `failed` (gave up, row kept), `spam` (honeypot, never sent) |
| `attempt_count` | Incremented when a row is claimed, before the send |
| `last_error` | Last send error, including the Email Service `code` when the binding provides one. Cleared on success |
| `next_attempt_at` | When a `pending` row becomes eligible. Null for `sent`, `failed`, and `spam` |
| `sent_at` | When the send was accepted |
| `claimed_at` | When the row moved to `sending`. A cron reclaims a claim older than `CLAIM_LEASE_SECONDS` so a crashed isolate does not strand the row |
| `message_id` | Email Service id, so a sent row can be matched to Email Service logs |
| `settings_json` | Per-form options. `subject` is the one this Worker reads today |

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
WHERE status IN ('pending', 'sending', 'failed')
ORDER BY created_at DESC;
```

## Delivery and retries

1. Insert as `pending` with `next_attempt_at` set to now.
2. Claim it with a conditional update (`pending` → `sending`, `attempt_count + 1`). The inline send and the cron use the same claim, so only one of them sends.
3. Call `env.EMAIL.send` with text, HTML, and `replyTo` when a submitter email is present.
4. On success: `sent`, `sent_at`, `message_id`.
5. On failure, if `attempt_count` is still below `MAX_ATTEMPTS`: back to `pending`, `last_error`, `next_attempt_at = now + delay`.
6. On failure at `MAX_ATTEMPTS`: `failed`. The row stays.

Delay is `RETRY_BASE_SECONDS * 2^(attempt-1)`, capped at `RETRY_MAX_SECONDS`. With the defaults, failures wait 60s, 120s, 240s, then 480s, and the fifth failure is final.

The cron is `*/5 * * * *`. A row is picked up only once it is due **and** a cron run happens, so the first retry lands on the next 5-minute tick after the 60-second backoff. Change `triggers.crons` if you want a tighter pickup. Each run sends at most 25 due rows.

A claim older than 10 minutes (`CLAIM_LEASE_SECONDS`) is put back to `pending` and tried again. That covers an isolate dying after the claim and before the result is saved. The window can send twice if the send succeeded and the process died before the `sent` update. The inline-versus-cron race does not: a live claim is not eligible.

| Var | Default | Meaning |
| --- | --- | --- |
| `EMAIL_FROM` | `forms@example.com` | From address. Must be on a domain onboarded to Email Sending |
| `EMAIL_FROM_NAME` | `Form Mail` | From display name |
| `MAX_ATTEMPTS` | `5` | Sends attempted before `failed` |
| `RETRY_BASE_SECONDS` | `60` | First backoff |
| `RETRY_MAX_SECONDS` | `3600` | Backoff cap |
| `CLAIM_LEASE_SECONDS` | `600` | How long a `sending` claim is held |
| `MAX_PAYLOAD_BYTES` | `100000` | Max request body. Enough for a long message, small enough to reject bulk junk |

`forms@example.com` is a placeholder. Sends fail, and rows stay `pending`, until you replace it with an address on an onboarded domain.

Local `wrangler dev` simulates `send_email` and does not deliver. Logged mail is not sent. Add `"remote": true` on the `send_email` binding only when you want local code to send real messages.

## Setup

You need a Cloudflare account, a zone on Cloudflare DNS, and Email Sending enabled for that zone. Email Sending is an open beta and Cloudflare documents it as a Workers paid-plan feature. Node.js 22 or newer.

```bash
npm install
npx wrangler login
npx wrangler d1 create form-mail
```

Put the printed database id in `wrangler.jsonc` in place of `00000000-0000-0000-0000-000000000000`.

```bash
npx wrangler d1 migrations apply form-mail --remote
```

Onboard the sending domain. Dashboard: **Compute** → **Email Service** → **Email Sending** → **Onboard Domain**. Or:

```bash
npx wrangler email sending enable yourdomain.com
```

Set `EMAIL_FROM` to an address on that domain and `EMAIL_FROM_NAME` to the name recipients should see. Edit the destination in `seed/example.sql`, then load the example form (or use the insert in the next section):

```bash
npx wrangler d1 execute form-mail --remote --file=seed/example.sql
npx wrangler deploy
```

The deploy output prints the workers.dev URL. Point forms at `https://<worker>.workers.dev/submit/<formId>`.

Nothing in this repository has been deployed, and the D1 id is not a real database.

## Add a form

```bash
npx wrangler d1 execute form-mail --remote --command "INSERT INTO forms (id, destination_email, settings_json, created_at) VALUES ('contact', 'you@example.com', '{\"subject\":\"New contact form submission\"}', '2026-01-01T00:00:00.000Z');"
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

Hide `_honeypot` visually and leave it empty. Bots that fill every input are stored as spam and are not emailed.

```html
<form action="https://YOUR_WORKER.workers.dev/submit/contact" method="POST">
  <p style="position:absolute;left:-9999px" aria-hidden="true">
    <label>Leave this empty <input type="text" name="_honeypot" tabindex="-1" autocomplete="off"></label>
  </p>
  <label>Name <input name="name" required></label>
  <label>Email <input name="email" type="email" required></label>
  <label>Message <textarea name="message" required></textarea></label>
  <input type="hidden" name="redirect" value="https://example.com/thanks">
  <button type="submit">Send</button>
</form>
```

JSON:

```bash
curl -X POST "https://YOUR_WORKER.workers.dev/submit/contact" \
  -H "content-type: application/json" \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","message":"Hello"}'
```

## Local development

```bash
npm install
npx wrangler d1 migrations apply form-mail --local
npx wrangler d1 execute form-mail --local --file=seed/example.sql
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
npx wrangler d1 execute form-mail --local \
  --command "SELECT id, status, attempt_count, last_error, sent_at FROM submissions ORDER BY created_at DESC LIMIT 5;"
```

## Tests

```bash
npm test
npm run typecheck
```

Vitest runs inside the Workers runtime via `@cloudflare/vitest-plugin` (the current package that replaces `@cloudflare/vitest-pool-workers`). The suite covers a saved submission, a successful send marked `sent`, a failed send left `pending` with backoff, a cron retry that sends and marks `sent`, max attempts marked `failed` with the row kept, an unknown form **404**, and the honeypot. Most cases install a fake sender so failure is deterministic. One case calls the local `send_email` binding, which does not deliver mail.

After changing bindings or vars, run `npm run types` and commit the regenerated `worker-configuration.d.ts`.
