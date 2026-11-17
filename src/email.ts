import {
  honeypotFieldName,
  isLikelyEmail,
  renderSubject,
  sanitizeHeader,
  timeZoneName,
  type FormSettings,
} from "./fields";

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

const TEST_SENDER = Symbol.for("need-forms.test-email-sender");

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

export function prettifyFieldName(name: string): string {
  const words = name.split(/[_-]+/).filter((word) => word.length > 0);
  if (words.length === 0) return name;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

export function formatReceivedAt(createdAt: string, timeZone: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(date);
}

function visibleFields(fields: Record<string, string>, settings: FormSettings): [string, string][] {
  const honeypot = honeypotFieldName(settings);
  return Object.entries(fields).filter(([key]) => {
    if (key.startsWith("_")) return false;
    if (key === honeypot || key === "redirect") return false;
    return true;
  });
}

function renderValueHtml(value: string): string {
  const trimmed = value.trim();
  if (isLikelyEmail(trimmed)) {
    const address = escapeHtml(trimmed);
    return `<a href="mailto:${address}" style="color:#1d4ed8;text-decoration:underline;">${address}</a>`;
  }
  return escapeHtml(value);
}

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function renderSubmissionEmail(input: {
  formId: string;
  submissionId: string;
  createdAt: string;
  fields: Record<string, string>;
  settings: FormSettings;
}): RenderedEmail {
  const subject = renderSubject(input.settings, input.fields, input.formId);
  const received = formatReceivedAt(input.createdAt, timeZoneName(input.settings));
  const heading = `New submission on ${input.formId}`;
  const footer = `Sent by Need Forms · ID ${input.submissionId}`;
  const fields = visibleFields(input.fields, input.settings);

  const textLines = [heading, received, ""];
  const rows: string[] = [];
  for (const [key, value] of fields) {
    const label = prettifyFieldName(key);
    textLines.push(`${label}: ${value}`);
    rows.push(
      `<tr>
<td style="padding:10px 12px;border-bottom:1px solid #e7e5e4;font-weight:700;color:#78716c;width:34%;vertical-align:top;">${escapeHtml(label)}</td>
<td style="padding:10px 12px;border-bottom:1px solid #e7e5e4;color:#1c1917;vertical-align:top;white-space:pre-wrap;">${renderValueHtml(value)}</td>
</tr>`,
    );
  }
  textLines.push("", footer);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;font-family:${FONT};color:#1c1917;">
<tr><td style="padding:24px 24px 4px;font-size:18px;line-height:1.4;font-weight:600;">${escapeHtml(heading)}</td></tr>
<tr><td style="padding:0 24px 16px;font-size:14px;line-height:1.4;color:#57534e;">${escapeHtml(received)}</td></tr>
<tr><td style="padding:0 24px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:${FONT};font-size:15px;line-height:1.45;">
${rows.join("\n")}
</table>
</td></tr>
<tr><td style="padding:16px 24px 24px;font-size:12px;line-height:1.4;color:#a8a29e;">${escapeHtml(footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text: textLines.join("\n"), html };
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
