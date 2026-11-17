import { backoffSeconds, readConfig } from "./config";
import { buildOutboundEmail, renderSubmissionEmail, sendFormEmail } from "./email";
import { isLikelyEmail, parseSettings } from "./fields";

const BATCH_LIMIT = 25;

export type DeliveryOutcome =
  | { outcome: "skipped" }
  | { outcome: "sent" }
  | { outcome: "pending" }
  | { outcome: "failed" };

type ClaimedSubmission = {
  id: string;
  form_id: string;
  payload_json: string;
  submitter_email: string | null;
  attempt_count: number;
  claimed_at: string;
  created_at: string;
};

type FormRow = {
  id: string;
  destination_email: string;
  settings_json: string;
};

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

async function claim(env: Env, id: string, nowIso: string): Promise<ClaimedSubmission | null> {
  const result = await env.DB.prepare(
    `UPDATE submissions
     SET status = 'sending',
         attempt_count = attempt_count + 1,
         claimed_at = ?1
     WHERE id = ?2
       AND status = 'pending'
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)`,
  )
    .bind(nowIso, id)
    .run();

  if ((result.meta.changes ?? 0) !== 1) return null;

  return env.DB.prepare(
    `SELECT id, form_id, payload_json, submitter_email, attempt_count, claimed_at, created_at
     FROM submissions
     WHERE id = ?1 AND status = 'sending' AND claimed_at = ?2`,
  )
    .bind(id, nowIso)
    .first<ClaimedSubmission>();
}

async function finish(
  env: Env,
  id: string,
  claimedAt: string,
  update: {
    status: "sent" | "pending" | "failed";
    sentAt: string | null;
    messageId: string | null;
    lastError: string | null;
    nextAttemptAt: string | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE submissions
     SET status = ?1,
         sent_at = ?2,
         message_id = COALESCE(?3, message_id),
         last_error = ?4,
         next_attempt_at = ?5,
         claimed_at = NULL
     WHERE id = ?6 AND status = 'sending' AND claimed_at = ?7`,
  )
    .bind(
      update.status,
      update.sentAt,
      update.messageId,
      update.lastError,
      update.nextAttemptAt,
      id,
      claimedAt,
    )
    .run();
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

async function loadForm(env: Env, formId: string): Promise<FormRow | null> {
  return env.DB.prepare(
    `SELECT id, destination_email, settings_json FROM forms WHERE id = ?1`,
  )
    .bind(formId)
    .first<FormRow>();
}

/**
 * Claim one pending row and try to email it.
 * A lost claim (another worker took it, or the lease moved on) is a skip, not a second send.
 */
export async function deliverSubmission(
  env: Env,
  id: string,
  now = new Date(),
): Promise<DeliveryOutcome> {
  const nowIso = now.toISOString();
  const config = readConfig(env);
  let claimed: ClaimedSubmission | null = null;
  try {
    claimed = await claim(env, id, nowIso);
    if (!claimed) return { outcome: "skipped" };

    const form = await loadForm(env, claimed.form_id);
    if (!form) {
      await finish(env, id, claimed.claimed_at, {
        status: "failed",
        sentAt: null,
        messageId: null,
        lastError: "form not found",
        nextAttemptAt: null,
      });
      return { outcome: "failed" };
    }
    if (!isLikelyEmail(form.destination_email) || !isLikelyEmail(config.emailFrom)) {
      throw new Error("destination or EMAIL_FROM is not a valid email address");
    }

    const fields = parsePayload(claimed.payload_json);
    const settings = parseSettings(form.settings_json);
    const rendered = renderSubmissionEmail({
      formId: form.id,
      submissionId: claimed.id,
      createdAt: claimed.created_at,
      fields,
      settings,
    });
    const message = buildOutboundEmail({
      to: form.destination_email.trim(),
      fromEmail: config.emailFrom.trim(),
      fromName: config.emailFromName,
      replyTo: claimed.submitter_email && isLikelyEmail(claimed.submitter_email)
        ? claimed.submitter_email
        : null,
      rendered,
    });
    const messageId = await sendFormEmail(env, message);
    await finish(env, id, claimed.claimed_at, {
      status: "sent",
      sentAt: nowIso,
      messageId,
      lastError: null,
      nextAttemptAt: null,
    });
    log("submission emailed", { id, formId: form.id, attempt: claimed.attempt_count, messageId });
    return { outcome: "sent" };
  } catch (error) {
    const reason = errorText(error);
    if (!claimed) {
      logError("delivery failed before claim", { id, error: reason });
      return { outcome: "skipped" };
    }
    const exhausted = claimed.attempt_count >= config.maxAttempts;
    const nextAttemptAt = exhausted
      ? null
      : new Date(
          now.getTime() +
            backoffSeconds(claimed.attempt_count, config.retryBaseSeconds, config.retryMaxSeconds) *
              1000,
        ).toISOString();
    const status = exhausted ? "failed" : "pending";
    await finish(env, id, claimed.claimed_at, {
      status,
      sentAt: null,
      messageId: null,
      lastError: reason,
      nextAttemptAt,
    });
    logError("email send failed", {
      id,
      formId: claimed.form_id,
      attempt: claimed.attempt_count,
      status,
      nextAttemptAt,
      error: reason,
    });
    return { outcome: status };
  }
}

async function releaseExpiredClaims(env: Env, now: Date): Promise<number> {
  const config = readConfig(env);
  const cutoff = new Date(now.getTime() - config.claimLeaseSeconds * 1000).toISOString();
  const result = await env.DB.prepare(
    `UPDATE submissions
     SET status = 'pending',
         next_attempt_at = ?1,
         claimed_at = NULL,
         last_error = COALESCE(last_error, 'send claim expired before completion')
     WHERE status = 'sending'
       AND claimed_at IS NOT NULL
       AND claimed_at <= ?2`,
  )
    .bind(now.toISOString(), cutoff)
    .run();
  return result.meta.changes ?? 0;
}

export async function processDueSubmissions(env: Env, now = new Date()): Promise<void> {
  const released = await releaseExpiredClaims(env, now);
  const nowIso = now.toISOString();
  const due = await env.DB.prepare(
    `SELECT id FROM submissions
     WHERE status = 'pending'
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
     ORDER BY created_at ASC
     LIMIT ?2`,
  )
    .bind(nowIso, BATCH_LIMIT)
    .all<{ id: string }>();

  const counts = { sent: 0, pending: 0, failed: 0, skipped: 0 };
  for (const row of due.results) {
    const result = await deliverSubmission(env, row.id, now);
    counts[result.outcome] += 1;
  }
  log("delivery pass complete", {
    released,
    due: due.results.length,
    ...counts,
  });
}
