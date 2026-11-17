import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { backoffSeconds } from "../src/config";
import { installTestPublisher } from "../src/deliver";
import { installTestSender, type OutboundEmail } from "../src/email";
import worker from "../src/index";

type SubmissionRow = {
  id: string;
  form_id: string;
  payload_json: string;
  submitter_email: string | null;
  status: string;
  attempt_count: number;
  last_error: string | null;
  next_attempt_at: string | null;
  sent_at: string | null;
  message_id: string | null;
  created_at: string;
};

const sent: OutboundEmail[] = [];

beforeEach(async () => {
  sent.length = 0;
  installTestPublisher(null);
  installTestSender(async (message) => {
    sent.push(message);
    return { messageId: "msg_test" };
  });
  await env.DB.prepare(`DELETE FROM submissions`).run();
  await env.DB.prepare(`DELETE FROM forms`).run();
  await env.DB.prepare(
    `INSERT INTO forms (id, destination_email, settings_json, created_at)
     VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(
      "contact",
      "owner@example.com",
      JSON.stringify({ subject: "Contact from {{name}}" }),
      "2026-01-01T00:00:00.000Z",
    )
    .run();
});

async function post(body: BodyInit, headers: HeadersInit, path = "/submit/contact"): Promise<{
  response: Response;
  json: { ok: boolean; id?: string; error?: string } | null;
}> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://need-forms.test${path}`, { method: "POST", headers, body }),
    env,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  let json: { ok: boolean; id?: string; error?: string } | null = null;
  if (response.headers.get("content-type")?.includes("application/json")) {
    json = JSON.parse(text) as { ok: boolean; id?: string; error?: string };
  }
  return { response, json };
}

async function row(id: string): Promise<SubmissionRow> {
  const found = await env.DB.prepare(`SELECT * FROM submissions WHERE id = ?1`)
    .bind(id)
    .first<SubmissionRow>();
  if (!found) throw new Error(`missing submission ${id}`);
  return found;
}

async function runQueue(queueName: string, submissionId: string, attempts = 1) {
  const ctx = createExecutionContext();
  const batch = createMessageBatch(queueName, [
    {
      id: `queue-${submissionId}-${attempts}`,
      timestamp: Date.now(),
      attempts,
      body: { submissionId },
    },
  ]);
  if (!worker.queue) throw new Error("queue handler missing");
  await worker.queue(batch, env, ctx);
  return getQueueResult(batch, ctx);
}

async function runCron(scheduledTime = Date.now()): Promise<void> {
  const ctx = createExecutionContext();
  if (!worker.scheduled) throw new Error("scheduled handler missing");
  await worker.scheduled(createScheduledController({ scheduledTime, cron: "0 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

async function insertPending(options: {
  attemptCount?: number;
  nextAttemptAt?: string | null;
  status?: string;
  createdAt?: string;
  lastError?: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO submissions (
       id, form_id, payload_json, submitter_email, status, attempt_count,
       last_error, next_attempt_at, sent_at, message_id, created_at
     ) VALUES (?1, 'contact', ?2, 'ada@example.com', ?3, ?4, ?5, ?6, NULL, NULL, ?7)`,
  )
    .bind(
      id,
      JSON.stringify({ name: "Ada", email: "ada@example.com", message: "Hello" }),
      options.status ?? "pending",
      options.attemptCount ?? 0,
      options.lastError ?? null,
      options.nextAttemptAt === undefined ? null : options.nextAttemptAt,
      options.createdAt ?? "2026-01-02T00:00:00.000Z",
    )
    .run();
  return id;
}

describe("backoff", () => {
  it("doubles until the cap", () => {
    expect(backoffSeconds(1, 60, 3600)).toBe(60);
    expect(backoffSeconds(2, 60, 3600)).toBe(120);
    expect(backoffSeconds(3, 60, 3600)).toBe(240);
    expect(backoffSeconds(10, 60, 3600)).toBe(3600);
  });
});

describe("POST /submit/:formId", () => {
  it("saves a JSON submission and leaves it pending until the queue consumer sends it", async () => {
    const { response, json } = await post(
      JSON.stringify({
        name: "Ada Lovelace",
        email: "ada@example.com",
        message: "Hello",
        redirect: "https://example.com/thanks",
        "math-sum": "",
      }),
      { "content-type": "application/json; charset=utf-8" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(json).toMatchObject({ ok: true });
    const saved = await row(json?.id ?? "");
    expect(saved.status).toBe("pending");
    expect(saved.attempt_count).toBe(0);
    expect(saved.next_attempt_at).toBeTruthy();
    expect(JSON.parse(saved.payload_json)).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      message: "Hello",
    });
    expect(sent).toHaveLength(0);

    const result = await runQueue("need-forms-delivery", saved.id);
    expect(result.explicitAcks).toContain(`queue-${saved.id}-1`);
    expect(result.retryMessages).toHaveLength(0);
    const delivered = await row(saved.id);
    expect(delivered.status).toBe("sent");
    expect(delivered.attempt_count).toBe(1);
    expect(delivered.sent_at).toBeTruthy();
    expect(delivered.message_id).toBe("msg_test");
    expect(delivered.last_error).toBeNull();
    expect(delivered.next_attempt_at).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "owner@example.com",
      from: { email: "no-reply@forms.neednot.net", name: "Need Forms" },
      replyTo: "ada@example.com",
      subject: "Contact from Ada Lovelace",
    });
    expect(sent[0]?.text).toContain("message: Hello");
    expect(sent[0]?.text).not.toContain("math-sum");
    expect(sent[0]?.text).not.toContain("example.com/thanks");
    expect(sent[0]?.html).toContain("Hello");
  });

  it("accepts an HTML form post and redirects", async () => {
    const body = new URLSearchParams({
      name: "Grace",
      email: "grace@example.com",
      message: "Hi",
      redirect: "https://example.com/thanks",
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://need-forms.test/submit/contact", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://example.com/thanks");
    const saved = await env.DB.prepare(`SELECT status, payload_json FROM submissions`).first<{
      status: string;
      payload_json: string;
    }>();
    expect(saved?.status).toBe("pending");
    expect(JSON.parse(saved?.payload_json ?? "{}")).toEqual({
      name: "Grace",
      email: "grace@example.com",
      message: "Hi",
    });
  });

  it("accepts multipart form posts", async () => {
    const form = new FormData();
    form.set("name", "Lin");
    form.set("message", "From a file-less form");
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://need-forms.test/submit/contact", { method: "POST", body: form }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const saved = await env.DB.prepare(
      `SELECT status, payload_json, submitter_email FROM submissions`,
    ).first<{ status: string; payload_json: string; submitter_email: string | null }>();
    expect(saved?.status).toBe("pending");
    expect(saved?.submitter_email).toBeNull();
    expect(JSON.parse(saved?.payload_json ?? "{}")).toEqual({
      name: "Lin",
      message: "From a file-less form",
    });
  });

  it("still returns success when the queue rejects the message", async () => {
    installTestPublisher(async () => {
      throw new Error("queue unavailable");
    });
    const { response, json } = await post(
      JSON.stringify({ name: "Ada", email: "ada@example.com", message: "Hello" }),
      { "content-type": "application/json" },
    );
    expect(response.status).toBe(200);
    expect(json?.ok).toBe(true);
    const saved = await row(json?.id ?? "");
    expect(saved.status).toBe("pending");
    expect(saved.next_attempt_at).toBeNull();
    expect(saved.attempt_count).toBe(0);
  });

  it("returns 404 for an unknown form and stores nothing", async () => {
    const { response, json } = await post(
      JSON.stringify({ name: "Ada", message: "Hello" }),
      { "content-type": "application/json" },
      "/submit/missing",
    );
    expect(response.status).toBe(404);
    expect(json).toEqual({ ok: false, error: "form_not_found" });
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM submissions`).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("drops the default math-sum honeypot without queueing or emailing it", async () => {
    const { response, json } = await post(
      JSON.stringify({
        name: "Bot",
        email: "bot@example.com",
        message: "Buy this",
        "math-sum": "https://spam.example",
      }),
      { "content-type": "application/json" },
    );
    expect(response.status).toBe(200);
    expect(json?.ok).toBe(true);
    const saved = await row(json?.id ?? "");
    expect(saved.status).toBe("spam");
    expect(saved.attempt_count).toBe(0);
    expect(saved.next_attempt_at).toBeNull();
    expect(JSON.parse(saved.payload_json)).toEqual({
      name: "Bot",
      email: "bot@example.com",
      message: "Buy this",
    });
    expect(JSON.stringify(saved.payload_json)).not.toContain("spam.example");

    const result = await runQueue("need-forms-delivery", saved.id);
    expect(result.explicitAcks).toContain(`queue-${saved.id}-1`);
    expect(sent).toHaveLength(0);
    expect((await row(saved.id)).status).toBe("spam");
  });

  it("uses settings_json.honeypot_field when a form overrides the field name", async () => {
    await env.DB.prepare(`UPDATE forms SET settings_json = ?1 WHERE id = 'contact'`)
      .bind(JSON.stringify({ subject: "Contact from {{name}}", honeypot_field: "company" }))
      .run();
    const { json } = await post(
      JSON.stringify({ name: "Bot", email: "bot@example.com", company: "Acme", "math-sum": "" }),
      { "content-type": "application/json" },
    );
    const saved = await row(json?.id ?? "");
    expect(saved.status).toBe("spam");
    expect(JSON.parse(saved.payload_json)).toEqual({
      name: "Bot",
      email: "bot@example.com",
      "math-sum": "",
    });
  });

  it("rejects an oversized body", async () => {
    const { response, json } = await post(
      new URLSearchParams({ message: "a".repeat(100_001) }),
      { "content-type": "application/x-www-form-urlencoded" },
    );
    expect(response.status).toBe(413);
    expect(json).toEqual({ ok: false, error: "payload_too_large" });
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM submissions`).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("answers CORS preflight for any origin", async () => {
    const response = await worker.fetch(
      new Request("https://need-forms.test/submit/contact", {
        method: "OPTIONS",
        headers: {
          origin: "https://blog.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("delivery queue", () => {
  it("retries a failed send with exponential backoff and keeps the row pending", async () => {
    installTestSender(async () => {
      throw Object.assign(new Error("mailbox unavailable"), { code: "E_RATE_LIMIT_EXCEEDED" });
    });
    const id = await insertPending({ attemptCount: 0 });
    const first = await runQueue("need-forms-delivery", id);
    expect(first.retryMessages.map((message) => message.msgId)).toEqual([`queue-${id}-1`]);
    let saved = await row(id);
    expect(saved.status).toBe("pending");
    expect(saved.attempt_count).toBe(1);
    expect(saved.last_error).toContain("E_RATE_LIMIT_EXCEEDED");
    expect(saved.last_error).toContain("mailbox unavailable");
    expect(saved.sent_at).toBeNull();
    let delayMs = Date.parse(saved.next_attempt_at ?? "") - Date.now();
    expect(delayMs).toBeGreaterThan(50_000);
    expect(delayMs).toBeLessThan(70_000);

    const second = await runQueue("need-forms-delivery", id, 2);
    expect(second.retryMessages.map((message) => message.msgId)).toEqual([`queue-${id}-2`]);
    saved = await row(id);
    expect(saved.attempt_count).toBe(2);
    delayMs = Date.parse(saved.next_attempt_at ?? "") - Date.now();
    expect(delayMs).toBeGreaterThan(110_000);
    expect(delayMs).toBeLessThan(130_000);
  });

  it("acks a message whose row is already sent", async () => {
    const id = await insertPending({ status: "sent", attemptCount: 1 });
    await env.DB.prepare(`UPDATE submissions SET sent_at = ?1, message_id = 'already' WHERE id = ?2`)
      .bind("2026-06-01T12:00:00.000Z", id)
      .run();
    const result = await runQueue("need-forms-delivery", id);
    expect(result.explicitAcks).toContain(`queue-${id}-1`);
    expect(result.retryMessages).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect((await row(id)).attempt_count).toBe(1);
  });

  it("marks a dead-lettered row failed and keeps the last error", async () => {
    const id = await insertPending({ attemptCount: 5, lastError: "mailbox unavailable" });
    const result = await runQueue("need-forms-delivery-dlq", id);
    expect(result.explicitAcks).toContain(`queue-${id}-1`);
    const saved = await row(id);
    expect(saved.status).toBe("failed");
    expect(saved.last_error).toBe("mailbox unavailable");
    expect(saved.next_attempt_at).toBeNull();
    expect(saved.sent_at).toBeNull();
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM submissions`).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("uses env.EMAIL.send when no test sender is installed", async () => {
    installTestSender(null);
    const id = await insertPending({});
    await runQueue("need-forms-delivery", id);
    const saved = await row(id);
    expect(saved.status).toBe("sent");
    expect(saved.message_id).toBeTruthy();
    expect(saved.message_id).not.toBe("msg_test");
  });
});

describe("hourly safety net", () => {
  it("re-enqueues a pending row that was never accepted by the queue", async () => {
    const createdAt = "2026-06-01T11:00:00.000Z";
    const id = await insertPending({ createdAt, nextAttemptAt: null });
    const scheduledTime = Date.parse("2026-06-01T12:00:00.000Z");
    await runCron(scheduledTime);
    const saved = await row(id);
    expect(saved.status).toBe("pending");
    expect(saved.next_attempt_at).toBe(new Date(scheduledTime).toISOString());
  });

  it("leaves a fresh pending row and an already queued row alone", async () => {
    const scheduledTime = Date.parse("2026-06-01T12:00:00.000Z");
    const fresh = await insertPending({
      createdAt: new Date(scheduledTime - 60_000).toISOString(),
      nextAttemptAt: null,
    });
    const queued = await insertPending({
      createdAt: "2026-06-01T10:00:00.000Z",
      nextAttemptAt: "2026-06-01T10:05:00.000Z",
    });
    await runCron(scheduledTime);
    expect((await row(fresh)).next_attempt_at).toBeNull();
    expect((await row(queued)).next_attempt_at).toBe("2026-06-01T10:05:00.000Z");
  });
});
