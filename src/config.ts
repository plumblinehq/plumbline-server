/**
 * Configuration, loaded once at process start.
 *
 * Fail-fast on missing required env: a server that comes up half-configured
 * and scans nothing is worse than one that refuses to boot — silence would
 * look exactly like success.
 */
export interface Config {
  /** Postgres connection string, e.g. postgres://user:pass@host:5432/plumbline */
  databaseUrl: string;
  /** Seconds between scheduled scans of the same anchor. Default 6h. */
  scanIntervalSeconds: number;
  /** ± fraction of SCAN_INTERVAL applied as scheduling jitter. Default 0.2. */
  scanJitterFraction: number;
  /** Max anchors scanned concurrently. Default 4. */
  scanConcurrency: number;
  /** A run exceeding this is marked aborted. Default 10 minutes. */
  runTimeoutSeconds: number;
  /** Port the HTTP API listens on. Default 3000. */
  port: number;
  /** Interface to bind. Default 0.0.0.0. */
  host: string;
  /** Max requests per IP per rate-limit window on the API. Default 300. */
  rateLimitMax: number;
  /** Rate-limit window in seconds. Default 60. */
  rateLimitWindowSeconds: number;
  /** Optional generic webhook URL for regression alerts; unset means no alerts. */
  regressionWebhookUrl: string | undefined;
  /** Seconds to suppress repeat alerts for the same regression. Default 24h. */
  alertCooldownSeconds: number;
  /** Trust X-Forwarded-For when the API sits behind a reverse proxy. Default false. */
  trustProxy: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") {
      throw new Error(
        `missing required environment variable ${name}; see README for the full list`,
      );
    }
    return value;
  };
  const integer = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") {
      return fallback;
    }
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer, got "${raw}"`);
    }
    return value;
  };
  const fraction = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") {
      return fallback;
    }
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${name} must be a number between 0 and 1, got "${raw}"`);
    }
    return value;
  };
  const optionalUrl = (name: string): string | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === "") {
      return undefined;
    }
    // Fail fast on a typo rather than silently never alerting: a webhook
    // that is not a URL is a misconfiguration, not an absent one.
    try {
      new URL(raw);
    } catch {
      throw new Error(`${name} must be a valid URL, got "${raw}"`);
    }
    return raw;
  };
  const boolean = (name: string, fallback: boolean): boolean => {
    const raw = env[name];
    if (raw === undefined || raw === "") {
      return fallback;
    }
    if (raw === "true" || raw === "1") {
      return true;
    }
    if (raw === "false" || raw === "0") {
      return false;
    }
    throw new Error(`${name} must be "true" or "false", got "${raw}"`);
  };
  return {
    databaseUrl: required("DATABASE_URL"),
    scanIntervalSeconds: integer("SCAN_INTERVAL", 6 * 60 * 60),
    scanJitterFraction: fraction("SCAN_JITTER", 0.2),
    scanConcurrency: integer("SCAN_CONCURRENCY", 4),
    runTimeoutSeconds: integer("RUN_TIMEOUT", 600),
    port: integer("PORT", 3000),
    host: env.HOST === undefined || env.HOST === "" ? "0.0.0.0" : env.HOST,
    rateLimitMax: integer("RATE_LIMIT_MAX", 300),
    rateLimitWindowSeconds: integer("RATE_LIMIT_WINDOW", 60),
    regressionWebhookUrl: optionalUrl("REGRESSION_WEBHOOK_URL"),
    alertCooldownSeconds: integer("ALERT_COOLDOWN", 24 * 60 * 60),
    trustProxy: boolean("TRUST_PROXY", false),
  };
}
