import { renderSubject, sanitizeHeader, type FormSettings } from "./fields";

export type OutboundEmail = {
  to: string;
  from: string | { email: string; name: string };
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
};

export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

const TEST_SENDER = Symbol.for("form-mail.test-email-sender");

export type TestEmailSender = (message: OutboundEmail) => Promise<{ messageId: string }>;

/**
 * Tests install a fake sender on globalThis so the fetch handler and the cron
 * share it. Production never calls this; sendFormEmail then uses env.EMAIL.
 */
export function installTestSender(sender: TestEmailSender | null): void {
  const target = globalThis as Record<symbol, TestEmailSender | undefined>;
  if (sender) target[TEST_SENDER] = sender;
  else delete target[TEST_SENDER];
}

function testSender(): TestEmailSender | undefined {
  return (globalThis as Record<symbol, TestEmailSender | undefined>)[TEST_SENDER];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderSubmissionEmail(input: {
  formId: string;
  submissionId: string;
  createdAt: string;
  fields: Record<string, string>;
  settings: FormSettings;
}): RenderedEmail {
  const subject = renderSubject(input.settings, input.fields, input.formId);
  const lines = [
    `Form: ${input.formId}`,
    `Submission: ${input.submissionId}`,
    `Received: ${input.createdAt}`,
    "",
  ];
  const rows: string[] = [];
  for (const [key, value] of Object.entries(input.fields)) {
    lines.push(`${key}: ${value}`);
    rows.push(
      `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`,
    );
  }
  if (Object.keys(input.fields).length === 0) {
    lines.push("(no fields)");
  }
  const text = lines.join("\n");
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body>
<p>Form <strong>${escapeHtml(input.formId)}</strong><br>
Submission ${escapeHtml(input.submissionId)}<br>
Received ${escapeHtml(input.createdAt)}</p>
<dl>${rows.join("")}</dl>
</body>
</html>`;
  return { subject, text, html };
}

export function buildOutboundEmail(input: {
  to: string;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
  rendered: RenderedEmail;
}): OutboundEmail {
  const fromName = sanitizeHeader(input.fromName);
  const message: OutboundEmail = {
    to: input.to,
    from: fromName.length > 0 ? { email: input.fromEmail, name: fromName } : input.fromEmail,
    subject: input.rendered.subject,
    text: input.rendered.text,
    html: input.rendered.html,
  };
  if (input.replyTo) message.replyTo = input.replyTo;
  return message;
}

export async function sendFormEmail(env: Env, message: OutboundEmail): Promise<string> {
  const fake = testSender();
  const result = fake ? await fake(message) : await env.EMAIL.send(message);
  if (!result || typeof result.messageId !== "string" || result.messageId.length === 0) {
    throw new Error("email send returned no message id");
  }
  return result.messageId;
}
