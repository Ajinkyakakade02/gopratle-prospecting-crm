/**
 * Redirect URL Allowlist & Environment Validation
 * Ensures OAuth redirect targets are strictly validated against trusted origins.
 */

function getEnv(key: string): string | undefined {
  if (typeof Deno !== "undefined" && Deno?.env?.get) {
    return Deno.env.get(key);
  }
  if (typeof process !== "undefined" && process?.env) {
    return process.env[key];
  }
  return undefined;
}

export function isDevelopmentMode(
  envGetter: (key: string) => string | undefined = getEnv,
): boolean {
  const env =
    envGetter("ENVIRONMENT") ||
    envGetter("DENO_ENV") ||
    envGetter("NODE_ENV");
  const allowLocalhost = envGetter("ALLOW_LOCALHOST_REDIRECTS");
  return (
    env?.toLowerCase() === "development" ||
    allowLocalhost?.toLowerCase() === "true"
  );
}

/**
 * Validate return_url against an allowlist of permitted CRM frontend origins.
 *
 * Rules:
 * 1. Localhost and 127.0.0.1 are ONLY allowed when development mode is explicitly enabled
 *    (via ENVIRONMENT=development, DENO_ENV=development, NODE_ENV=development, or ALLOW_LOCALHOST_REDIRECTS=true).
 * 2. In production / non-dev, only CRM_FRONTEND_URL and origins in ALLOWED_REDIRECT_ORIGINS (comma-separated) are permitted.
 * 3. Any untrusted, unrecognized, or invalid return_url is rejected and falls back to defaultFrontendUrl / CRM_FRONTEND_URL.
 */
export function validateReturnUrl(
  url: string,
  defaultFrontendUrl?: string,
  envGetter: (key: string) => string | undefined = getEnv,
): string {
  const crmFrontendUrl = envGetter("CRM_FRONTEND_URL");
  const fallbackUrl = defaultFrontendUrl || crmFrontendUrl || "http://localhost:5173";

  if (!url || typeof url !== "string") {
    return fallbackUrl;
  }

  try {
    const parsed = new URL(url);
    const isDev = isDevelopmentMode(envGetter);

    // Development mode check for localhost / 127.0.0.1
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      if (isDev) {
        return url;
      }
      console.warn(`Rejected localhost return_url in production/non-dev mode: ${parsed.origin}`);
      return fallbackUrl;
    }

    // Build allowlist of permitted origins
    const allowedOrigins = new Set<string>();
    if (crmFrontendUrl) {
      try {
        allowedOrigins.add(new URL(crmFrontendUrl).origin);
      } catch {
        // invalid CRM_FRONTEND_URL
      }
    }

    const additionalOrigins = envGetter("ALLOWED_REDIRECT_ORIGINS");
    if (additionalOrigins) {
      for (const origin of additionalOrigins.split(",")) {
        const trimmed = origin.trim();
        if (trimmed) {
          try {
            allowedOrigins.add(new URL(trimmed).origin);
          } catch {
            // invalid origin
          }
        }
      }
    }

    if (allowedOrigins.has(parsed.origin)) {
      return url;
    }

    console.warn(`Rejected untrusted return_url origin: ${parsed.origin}`);
    return fallbackUrl;
  } catch {
    return fallbackUrl;
  }
}
