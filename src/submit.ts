import { readConfig } from "./config";
import { deliverSubmission } from "./deliver";
import {
  findSubmitterEmail,
  isFormId,
  partitionFields,
  serializeJsonValue,
} from "./fields";
import { HttpError, htmlResponse, jsonResponse, mediaType, redirectResponse } from "./http";

const MAX_FIELDS = 100;

type FormHit = { id: string };

async function readCapped(request: Request, max: number): Promise<ArrayBuffer> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new HttpError(400, "invalid_content_length");
    if (Number(declared) > max) throw new HttpError(413, "payload_too_large");
  }
  const body = request.body;
  if (!body) return new ArrayBuffer(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) throw new HttpError(413, "payload_too_large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

function addField(fields: Record<string, string>, key: string, value: string): void {
  const existing = fields[key];
  fields[key] = existing === undefined ? value : `${existing}, ${value}`;
}

async function readFields(request: Request, maxBytes: number): Promise<{
  fields: Record<string, string>;
  htmlForm: boolean;
}> {
  const type = mediaType(request);
  const bytes = await readCapped(request, maxBytes);
  if (type === "application/json") {
    const text = new TextDecoder().decode(bytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(400, "invalid_json");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "invalid_json");
    }
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const serialized = serializeJsonValue(value);
      if (serialized === null) continue;
      addField(fields, key, serialized);
    }
    return { fields, htmlForm: false };
  }

  if (type === "application/x-www-form-urlencoded") {
    const params = new URLSearchParams(new TextDecoder().decode(bytes));
    const fields: Record<string, string> = {};
    for (const [key, value] of params.entries()) addField(fields, key, value);
    return { fields, htmlForm: true };
  }

  if (type === "multipart/form-data") {
    const rebuilt = new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? type },
      body: bytes,
    });
    const form = await rebuilt.formData();
    const fields: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value !== "string") throw new HttpError(400, "file_uploads_unsupported");
      addField(fields, key, value);
    }
    return { fields, htmlForm: true };
  }

  throw new HttpError(415, "unsupported_media_type");
}

function thankYouPage(id: string): string {
  const safeId = id.replaceAll(/[^A-Za-z0-9-]/g, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Message received</title>
<style>
  body { font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; background: #f6f5f2; color: #1c1916; }
  main { max-width: 36rem; margin: 4rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
  code { font-size: 0.9em; }
</style>
</head>
<body>
<main>
  <h1>Message received</h1>
  <p>Thanks. Your submission is saved and queued for delivery.</p>
  <p>Reference <code>${safeId}</code></p>
</main>
</body>
</html>`;
}

export async function handleSubmit(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  formId: string,
): Promise<Response> {
  if (!isFormId(formId)) return jsonResponse({ ok: false, error: "form_not_found" }, 404);

  const form = await env.DB.prepare(`SELECT id FROM forms WHERE id = ?1`)
    .bind(formId)
    .first<FormHit>();
  if (!form) return jsonResponse({ ok: false, error: "form_not_found" }, 404);

  const config = readConfig(env);
  const { fields: rawFields, htmlForm } = await readFields(request, config.maxPayloadBytes);
  if (Object.keys(rawFields).length > MAX_FIELDS) throw new HttpError(400, "too_many_fields");

  const partitioned = partitionFields(rawFields);
  if (!partitioned.honeypotTripped && Object.keys(partitioned.fields).length === 0) {
    throw new HttpError(400, "empty_submission");
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const submitter = partitioned.honeypotTripped ? null : findSubmitterEmail(partitioned.fields);
  const status = partitioned.honeypotTripped ? "spam" : "pending";

  await env.DB.prepare(
    `INSERT INTO submissions (
       id, form_id, payload_json, submitter_email, status, attempt_count,
       last_error, next_attempt_at, sent_at, claimed_at, message_id, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6, NULL, NULL, NULL, ?7)`,
  )
    .bind(
      id,
      form.id,
      JSON.stringify(partitioned.fields),
      submitter,
      status,
      status === "pending" ? createdAt : null,
      createdAt,
    )
    .run();

  if (status === "pending") {
    ctx.waitUntil(
      deliverSubmission(env, id).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ message: "background delivery crashed", id, error: message }));
      }),
    );
  }

  console.log(JSON.stringify({ message: "submission stored", id, formId: form.id, status }));

  if (htmlForm && partitioned.redirect) return redirectResponse(partitioned.redirect);
  if (htmlForm) return htmlResponse(thankYouPage(id));
  return jsonResponse({ ok: true, id }, 200);
}
