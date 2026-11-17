export const DEFAULT_HONEYPOT_FIELD = "math-sum";

const FORM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const EMAIL_PATTERN = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const FIELD_NAME_PATTERN = /^[^\u0000-\u001F\u007F]{1,100}$/;

export type FormSettings = {
  /** Subject template. Supports `{{field_name}}` and `{{form_id}}`. */
  subject?: string;
  /** Submission field that traps bots when it is non-empty. Defaults to `math-sum`. */
  honeypot_field?: string;
};

export type PartitionedFields = {
  fields: Record<string, string>;
  honeypotTripped: boolean;
  redirect: string | null;
};

export function isFormId(value: string): boolean {
  return FORM_ID_PATTERN.test(value);
}

export function parseSettings(json: string): FormSettings {
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as { subject?: unknown; honeypot_field?: unknown };
    const settings: FormSettings = {};
    if (typeof record.subject === "string" && record.subject.trim().length > 0) {
      settings.subject = record.subject.trim();
    }
    if (typeof record.honeypot_field === "string" && record.honeypot_field.trim().length > 0) {
      settings.honeypot_field = record.honeypot_field.trim();
    }
    return settings;
  } catch {
    return {};
  }
}

export function honeypotFieldName(settings: FormSettings): string {
  const custom = settings.honeypot_field;
  if (
    custom &&
    FIELD_NAME_PATTERN.test(custom) &&
    custom !== "redirect" &&
    custom !== "_redirect"
  ) {
    return custom;
  }
  return DEFAULT_HONEYPOT_FIELD;
}

export function isLikelyEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return false;
  return EMAIL_PATTERN.test(trimmed);
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[-_\s]/g, "");
}

/** First field that looks like an email address, for Reply-To. */
export function findSubmitterEmail(fields: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(fields)) {
    const normalized = normalizedKey(key);
    if (normalized !== "email" && normalized !== "emailaddress") continue;
    const trimmed = value.trim();
    if (isLikelyEmail(trimmed)) return trimmed;
  }
  return null;
}

export function safeRedirect(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2000) return null;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.toString();
}

export function partitionFields(
  input: Record<string, string>,
  honeypotField = DEFAULT_HONEYPOT_FIELD,
): PartitionedFields {
  const redirect = safeRedirect(input.redirect?.trim() || input._redirect?.trim() || undefined);
  const honeypot = input[honeypotField] ?? "";
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === honeypotField || key === "redirect" || key === "_redirect") continue;
    if (!FIELD_NAME_PATTERN.test(key)) continue;
    fields[key] = value;
  }
  return {
    fields,
    honeypotTripped: honeypot.trim().length > 0,
    redirect,
  };
}

export function serializeJsonValue(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return String(raw);
  }
  if (typeof raw === "boolean") return String(raw);
  try {
    return JSON.stringify(raw);
  } catch {
    return null;
  }
}

export function sanitizeHeader(value: string): string {
  return value
    .replaceAll(/[\r\n]+/g, " ")
    .replaceAll(/[\u0000-\u001F\u007F]/g, "")
    .trim();
}

export function renderSubject(
  settings: FormSettings,
  fields: Record<string, string>,
  formId: string,
): string {
  const template = settings.subject ?? "New form submission ({{form_id}})";
  const rendered = template.replaceAll(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (_match, key: string) => {
    if (key === "form_id") return formId;
    return fields[key] ?? "";
  });
  const subject = sanitizeHeader(rendered).slice(0, 180);
  if (subject.length > 0) return subject;
  return `New form submission (${sanitizeHeader(formId).slice(0, 64)})`;
}
