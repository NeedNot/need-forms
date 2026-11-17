export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type",
  "access-control-max-age": "86400",
} as const;

export function corsHeaders(): Headers {
  return new Headers(CORS_HEADERS);
}

export function jsonResponse(body: unknown, status: number): Response {
  const headers = corsHeaders();
  headers.set("cache-control", "no-store");
  return Response.json(body, { status, headers });
}

export function htmlResponse(html: string, status = 200): Response {
  const headers = corsHeaders();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(html, { status, headers });
}

export function redirectResponse(location: string): Response {
  const headers = corsHeaders();
  headers.set("location", location);
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 303, headers });
}

export function textResponse(text: string, status = 200): Response {
  const headers = corsHeaders();
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(text, { status, headers });
}

export function mediaType(request: Request): string {
  const raw = request.headers.get("content-type") ?? "";
  return raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}
