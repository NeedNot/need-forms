import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { backoffSeconds } from "../src/config";
import { deliverSubmission } from "../src/deliver";
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
  claimed_at: string | null;
  message_id: string | null;
  created_at: string;
};

const sent: OutboundEmail[] = [];

beforeEach(async () => {
  sent.length = 0;
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
    new Request(`https://form-mail.test${path}`, { method: "POST", headers, body }),
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

async function runCron(scheduledTime = Date.now()): Promise<void> {
  const ctx = createExecutionContext();
  if (!worker.scheduled) throw new Error("scheduled handler missing");
  await worker.scheduled(
    createScheduledController({ scheduledTime, cron: "*/5 * * * *" }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

async function insertPending(options: {
  attemptCount?: number;
  nextAttemptAt?: string;
  status?: string;
  claimedAt?: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  const status = options.status ?? "pending";
  await env.DB.prepare(
    `INSERT INTO submissions (
       id, form_id, payload_json, submitter_email, status, attempt_count,
       last_error, next_attempt_at, sent_at, claimed_at, message_id, created_at
     ) VALUES (?1, 'contact', ?2, 'ada@example.com', ?3, ?4, NULL, ?5, NULL, ?6, NULL, ?7)`,
  )
    .bind(
      id,
      JSON.stringify({ name: "Ada", email: "ada@example.com", message: "Hello" }),
      status,
      options.attemptCount ?? 0,
      options.nextAttemptAt ?? "2020-01-01T00:00:00.000Z",
      options.claimedAt ?? null,
      "2026-01-02T00:00:00.000Z",
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
  it("saves a JSON submission and a successful send marks it sent", async () => {
    const { response, json } = await post(
      JSON.stringify({
        name: "Ada Lovelace",
        email: "ada@example.com",
        message: "Hello",
        redirect: "https://example.com/thanks",
      }),
      { "content-type": "application/json; charset=utf-8" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(json).toMatchObject({ ok: true });
    expect(json?.id).toBeTruthy();

    const saved = await row(json?.id ?? "");
    expect(saved.status).toBe("sent");
    expect(saved.form_id).toBe("contact");
    expect(saved.attempt_count).toBe(1);
    expect(saved.sent_at).toBeTruthy();
    expect(saved.message_id).toBe("msg_test");
    expect(saved.last_error).toBeNull();
    expect(saved.next_attempt_at).toBeNull();
    expect(saved.submitter_email).toBe("ada@example.com");
    expect(JSON.parse(saved.payload_json)).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      message: "Hello",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "owner@example.com",
      from: { email: "forms@example.com", name: "Form Mail" },
      replyTo: "ada@example.com",
      subject: "Contact from Ada Lovelace",
    });
    expect(sent[0]?.text).toContain("message: Hello");
    expect(sent[0]?.text).not.toContain("example.com/thanks");
    expect(sent[0]?.html).toContain("Hello");
    expect(sent[0]?.html).toContain("<dt>name</dt>");
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
      new Request("https://form-mail.test/submit/contact", {
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
    const saved = await env.DB.prepare(`SELECT status, payload_json FROM submissions`)
      .first<{ status: string; payload_json: string }>();
    expect(saved?.status).toBe("sent");
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
      new Request("https://form-mail.test/submit/contact", { method: "POST", body: form }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const saved = await env.DB.prepare(`SELECT status, payload_json, submitter_email FROM submissions`)
      .first<{ status: string; payload_json: string; submitter_email: string | null }>();
    expect(saved?.status).toBe("sent");
    expect(saved?.submitter_email).toBeNull();
    expect(JSON.parse(saved?.payload_json ?? "{}")).toEqual({
      name: "Lin",
      message: "From a file-less form",
    });
    expect(sent[0]?.replyTo).toBeUndefined();
  });

  it("keeps the request successful when sending fails and schedules a backoff", async () => {
    installTestSender(async () => {
      throw Object.assign(new Error("mailbox unavailable"), { code: "E_RATE_LIMIT_EXCEEDED" });
    });
    const before = Date.now();
    const { response, json } = await post(
      JSON.stringify({ name: "Ada", email: "ada@example.com", message: "Hello" }),
      { "content-type": "application/json" },
    );
    const after = Date.now();

    expect(response.status).toBe(200);
    expect(json?.ok).toBe(true);
    const saved = await row(json?.id ?? "");
    expect(saved.status).toBe("pending");
    expect(saved.attempt_count).toBe(1);
    expect(saved.sent_at).toBeNull();
    expect(saved.message_id).toBeNull();
    expect(saved.last_error).toContain("E_RATE_LIMIT_EXCEEDED");
    expect(saved.last_error).toContain("mailbox unavailable");
    const next = Date.parse(saved.next_attempt_at ?? "");
    expect(next).toBeGreaterThanOrEqual(before + 60_000 - 5_000);
    expect(next).toBeLessThanOrEqual(after + 60_000 + 5_000);
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
    expect(sent).toHaveLength(0);
  });

  it("drops honeypot submissions without emailing them", async () => {
    const { response, json } = await post(
      JSON.stringify({
        name: "Bot",
        email: "bot@example.com",
        message: "Buy this",
        _honeypot: "https://spam.example",
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
    expect(sent).toHaveLength(0);

    await runCron();
    expect(sent).toHaveLength(0);
    expect((await row(saved.id)).status).toBe("spam");
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
      new Request("https://form-mail.test/submit/contact", {
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

describe("cron retries", () => {
  it("sends a due submission and marks it sent", async () => {
    const id = await insertPending({ attemptCount: 1, nextAttemptAt: "2020-01-01T00:00:00.000Z" });
    const scheduledTime = Date.parse("2026-06-01T12:00:00.000Z");
    await runCron(scheduledTime);

    const saved = await row(id);
    expect(saved.status).toBe("sent");
    expect(saved.attempt_count).toBe(2);
    expect(saved.sent_at).toBe(new Date(scheduledTime).toISOString());
    expect(saved.message_id).toBe("msg_test");
    expect(saved.last_error).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("owner@example.com");
  });

  it("leaves a future retry pending", async () => {
    const id = await insertPending({
      attemptCount: 1,
      nextAttemptAt: "2099-01-01T00:00:00.000Z",
    });
    await runCron(Date.parse("2026-06-01T12:00:00.000Z"));
    const saved = await row(id);
    expect(saved.status).toBe("pending");
    expect(saved.attempt_count).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("applies exponential backoff on the next failed attempt", async () => {
    installTestSender(async () => {
      throw new Error("still down");
    });
    const id = await insertPending({ attemptCount: 1, nextAttemptAt: "2020-01-01T00:00:00.000Z" });
    const scheduledTime = Date.parse("2026-06-01T12:00:00.000Z");
    await runCron(scheduledTime);

    const saved = await row(id);
    expect(saved.status).toBe("pending");
    expect(saved.attempt_count).toBe(2);
    expect(saved.last_error).toContain("still down");
    expect(saved.next_attempt_at).toBe(new Date(scheduledTime + 120_000).toISOString());
  });

  it("marks the row failed after the last attempt and keeps it", async () => {
    installTestSender(async () => {
      throw new Error("permanent");
    });
    const id = await insertPending({ attemptCount: 4, nextAttemptAt: "2020-01-01T00:00:00.000Z" });
    await runCron(Date.parse("2026-06-01T12:00:00.000Z"));

    const saved = await row(id);
    expect(saved.status).toBe("failed");
    expect(saved.attempt_count).toBe(5);
    expect(saved.sent_at).toBeNull();
    expect(saved.next_attempt_at).toBeNull();
    expect(saved.last_error).toContain("permanent");
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM submissions`).first<{ n: number }>();
    expect(count?.n).toBe(1);

    sent.length = 0;
    installTestSender(async (message) => {
      sent.push(message);
      return { messageId: "msg_should_not_send" };
    });
    await runCron(Date.parse("2026-06-01T13:00:00.000Z"));
    expect(sent).toHaveLength(0);
    expect((await row(id)).status).toBe("failed");
  });

  it("reclaims an expired send claim and then sends once", async () => {
    const id = await insertPending({
      status: "sending",
      attemptCount: 1,
      claimedAt: "2026-06-01T11:00:00.000Z",
      nextAttemptAt: "2020-01-01T00:00:00.000Z",
    });
    await runCron(Date.parse("2026-06-01T12:00:00.000Z"));
    const saved = await row(id);
    expect(saved.status).toBe("sent");
    expect(saved.attempt_count).toBe(2);
    expect(sent).toHaveLength(1);
  });

  it("does not send a row that is already claimed", async () => {
    const id = await insertPending({
      status: "sending",
      attemptCount: 1,
      claimedAt: new Date().toISOString(),
      nextAttemptAt: "2020-01-01T00:00:00.000Z",
    });
    await runCron();
    expect(sent).toHaveLength(0);
    expect((await row(id)).status).toBe("sending");
  });

  it("claims a pending row only once when delivery overlaps", async () => {
    const id = await insertPending({ attemptCount: 0, nextAttemptAt: "2020-01-01T00:00:00.000Z" });
    const now = new Date("2026-06-01T12:00:00.000Z");
    await Promise.all([deliverSubmission(env, id, now), deliverSubmission(env, id, now)]);
    expect(sent).toHaveLength(1);
    const saved = await row(id);
    expect(saved.status).toBe("sent");
    expect(saved.attempt_count).toBe(1);
  });
});

describe("email binding", () => {
  it("uses env.EMAIL.send when no test sender is installed", async () => {
    installTestSender(null);
    const direct = await env.EMAIL.send({
      to: "owner@example.com",
      from: { email: "forms@example.com", name: "Form Mail" },
      replyTo: "ada@example.com",
      subject: "Binding check",
      text: "Binding check",
      html: "<p>Binding check</p>",
    });
    expect(direct.messageId).toBeTruthy();

    const { json } = await post(
      JSON.stringify({ name: "Ada", email: "ada@example.com", message: "Via binding" }),
      { "content-type": "application/json" },
    );
    const saved = await row(json?.id ?? "");
    expect(saved.status, saved.last_error ?? "no error").toBe("sent");
    expect(saved.message_id).toBeTruthy();
    expect(saved.message_id).not.toBe("msg_test");
  });
});
