export type AppConfig = {
  emailFrom: string;
  emailFromName: string;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  maxPayloadBytes: number;
};

function positiveInt(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function readConfig(env: Env): AppConfig {
  return {
    emailFrom: env.EMAIL_FROM,
    emailFromName: env.EMAIL_FROM_NAME,
    retryBaseSeconds: positiveInt(env.RETRY_BASE_SECONDS, 60),
    retryMaxSeconds: positiveInt(env.RETRY_MAX_SECONDS, 3600),
    maxPayloadBytes: positiveInt(env.MAX_PAYLOAD_BYTES, 100_000),
  };
}

/** Delay after `attempt` failed tries. Attempt 1 waits `base`, then doubles, capped. */
export function backoffSeconds(attempt: number, base: number, cap: number): number {
  const exponent = Math.max(0, attempt - 1);
  const delay = base * 2 ** exponent;
  if (!Number.isFinite(delay) || delay > cap) return cap;
  return Math.max(1, Math.floor(delay));
}
