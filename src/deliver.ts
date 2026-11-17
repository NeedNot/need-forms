import { backoffSeconds, readConfig } from "./config";
import { buildOutboundEmail, renderSubmissionEmail, sendFormEmail } from "./email";
import { isLikelyEmail, parseSettings } from "./fields";

export const DELIVERY_QUEUE_NAME = "need-forms-delivery";
export const DELIVERY_DLQ_NAME = "need-forms-delivery-dlq";

/** Pending rows with no queue acceptance older than this are enqueued again. */
const STALE_PENDING_MS = 15 * 60 * 1000;
const CRON_BATCH_LIMIT = 25;

const TEST_PUBLISHER = Symbol.for("need-forms.test-publisher");

export type DeliveryMessage = {
  submissionId: string;
};

type TestPublisher = (submissionId: string) => Promise<void>;

type SubmissionRow = {
  id: string;
  form_id: string;
  payload_json: string;
  submitter_email: string | null;
  status: string;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
};

type FormRow = {
  id: string;
  destination_email: string;
  settings_json: string;
};

/**
 * Tests can force the producer to fail. Production leaves this unset and uses
 * env.DELIVERY_QUEUE.
 */
export function installTestPublisher(publisher: TestPublisher | null): void {
  const target = globalThis as Record<symbol, TestPublisher | undefined>;
  if (publisher) target[TEST_PUBLISHER] = publisher;
  else delete target[TEST_PUBLISHER];
}

function testPublisher(): TestPublisher | undefined {
  return (globalThis as Record<symbol, TestPublisher | undefined>)[TEST_PUBLISHER];
}

function errorText(error: unknown): string {
  let code: string | null = null;
  if (typeof error === "object" && error !== null && "code" in error) {
    const value = (error as { code: unknown }).code;
    if (typeof value === "string" && value.length > 0) code = value;
  }
  const message = error instanceof Error ? error.message : String(error);
  const text = code ? `${code}: ${message}` : message;
  return text.replaceAll(/[\r\n]+/g, " ").slice(0, 500);
}

function log(message: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ message, ...fields }));
}

function logError(message: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ message, ...fields }));
}

function submissionIdOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const id = (body as { submissionId?: unknown }).submissionId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function publishDelivery(env: Env, submissionId: string, now = new Date()): Promise<boolean> {
  try {
    const publisher = testPublisher();
    if (publisher) await publisher(submissionId);
    else await env.DELIVERY_QUEUE.send({ submissionId });
    await env.DB.prepare(
      `UPDATE submissions
       SET next_attempt_at = ?1
       WHERE id = ?2 AND status = 'pending' AND next_attempt_at IS NULL`,
    )
      .bind(now.toISOString(), submissionId)
      .run();
    return true;
  } catch (error) {
    logError("enqueue failed", { submissionId, error: errorText(error) });
    return false;
  }
}

async function loadSubmission(env: Env, id: string): Promise<SubmissionRow | null> {
  return env.DB.prepare(
    `SELECT id, form_id, payload_json, submitter_email, status, attempt_count, last_error, created_at
     FROM submissions WHERE id = ?1`,
  )
    .bind(id)
    .first<SubmissionRow>();
}

function parsePayload(payloadJson: string): Record<string, string> {
  const parsed: unknown = JSON.parse(payloadJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("stored payload is not an object");
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

async function sendRow(env: Env, row: SubmissionRow): Promise<string> {
  const config = readConfig(env);
  const form = await env.DB.prepare(
    `SELECT id, destination_email, settings_json FROM forms WHERE id = ?1`,
  )
    .bind(row.form_id)
    .first<FormRow>();
  if (!form) throw new Error("form not found");
  if (!isLikelyEmail(form.destination_email) || !isLikelyEmail(config.emailFrom)) {
    throw new Error("destination or EMAIL_FROM is not a valid email address");
  }
  const fields = parsePayload(row.payload_json);
  const rendered = renderSubmissionEmail({
    formId: form.id,
    submissionId: row.id,
    createdAt: row.created_at,
    fields,
    settings: parseSettings(form.settings_json),
  });
  return sendFormEmail(
    env,
    buildOutboundEmail({
      to: form.destination_email.trim(),
      fromEmail: config.emailFrom.trim(),
      fromName: config.emailFromName,
      replyTo: row.submitter_email && isLikelyEmail(row.submitter_email) ? row.submitter_email : null,
      rendered,
    }),
  );
}

async function consumeDelivery(env: Env, message: Message<unknown>, now: Date): Promise<void> {
  const id = submissionIdOf(message.body);
  if (!id) {
    logError("discarding delivery message without submissionId", { messageId: message.id });
    message.ack();
    return;
  }

  const row = await loadSubmission(env, id);
  if (!row || row.status === "sent" || row.status === "spam" || row.status === "failed") {
    message.ack();
    return;
  }

  try {
    const providerId = await sendRow(env, row);
    await env.DB.prepare(
      `UPDATE submissions
       SET status = 'sent',
           sent_at = ?1,
           message_id = ?2,
           attempt_count = attempt_count + 1,
           last_error = NULL,
           next_attempt_at = NULL
       WHERE id = ?3 AND status = 'pending'`,
    )
      .bind(now.toISOString(), providerId, id)
      .run();
    log("submission emailed", { id, attempt: row.attempt_count + 1, messageId: providerId });
    message.ack();
  } catch (error) {
    const reason = errorText(error);
    const attempt = row.attempt_count + 1;
    const config = readConfig(env);
    const delaySeconds = backoffSeconds(attempt, config.retryBaseSeconds, config.retryMaxSeconds);
    const nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
    await env.DB.prepare(
      `UPDATE submissions
       SET attempt_count = attempt_count + 1,
           last_error = ?1,
           next_attempt_at = ?2
       WHERE id = ?3 AND status = 'pending'`,
    )
      .bind(reason, nextAttemptAt, id)
      .run();
    logError("email send failed", { id, attempt, delaySeconds, error: reason });
    message.retry({ delaySeconds });
  }
}

async function consumeDeadLetter(env: Env, message: Message<unknown>): Promise<void> {
  const id = submissionIdOf(message.body);
  if (id) {
    await env.DB.prepare(
      `UPDATE submissions
       SET status = 'failed',
           next_attempt_at = NULL,
           last_error = COALESCE(last_error, 'delivery retries exhausted')
       WHERE id = ?1 AND status = 'pending'`,
    )
      .bind(id)
      .run();
    logError("delivery moved to dead letter", { id });
  }
  message.ack();
}

export async function handleQueueBatch(batch: MessageBatch<unknown>, env: Env, now = new Date()): Promise<void> {
  for (const message of batch.messages) {
    if (batch.queue === DELIVERY_DLQ_NAME) await consumeDeadLetter(env, message);
    else await consumeDelivery(env, message, now);
  }
}

export async function reenqueueStalePending(env: Env, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - STALE_PENDING_MS).toISOString();
  const due = await env.DB.prepare(
    `SELECT id FROM submissions
     WHERE status = 'pending'
       AND next_attempt_at IS NULL
       AND created_at <= ?1
     ORDER BY created_at ASC
     LIMIT ?2`,
  )
    .bind(cutoff, CRON_BATCH_LIMIT)
    .all<{ id: string }>();

  let enqueued = 0;
  for (const row of due.results) {
    if (await publishDelivery(env, row.id, now)) enqueued += 1;
  }
  log("stale pending pass complete", { due: due.results.length, enqueued });
}
