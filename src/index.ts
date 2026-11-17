import { processDueSubmissions } from "./deliver";
import { corsHeaders, HttpError, jsonResponse, textResponse } from "./http";
import { handleSubmit } from "./submit";

const FORM_PATH = /^\/submit\/([^/]+)$/;

function logError(error: unknown, path: string): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ message: "request failed", path, error: message }));
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      if (request.method === "GET" && url.pathname === "/") {
        return textResponse("Form mail is running. POST submissions to /submit/<formId>.");
      }

      const match = FORM_PATH.exec(url.pathname);
      if (!match) return jsonResponse({ ok: false, error: "not_found" }, 404);

      if (request.method !== "POST") {
        return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
      }

      let formId: string;
      try {
        formId = decodeURIComponent(match[1] ?? "");
      } catch {
        return jsonResponse({ ok: false, error: "form_not_found" }, 404);
      }

      return await handleSubmit(request, env, ctx, formId);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse({ ok: false, error: error.code }, error.status);
      }
      logError(error, url.pathname);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }
  },

  async scheduled(controller, env, _ctx): Promise<void> {
    const when = Number.isFinite(controller.scheduledTime)
      ? new Date(controller.scheduledTime)
      : new Date();
    console.log(
      JSON.stringify({
        message: "cron started",
        cron: controller.cron,
        scheduledTime: when.toISOString(),
      }),
    );
    await processDueSubmissions(env, when);
  },
} satisfies ExportedHandler<Env>;
