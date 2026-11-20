import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// -----------------------------------------------------------------------------
// Inlined Shared Utilities & AES-256-GCM Encryption for Supabase Dashboard Web UI
// -----------------------------------------------------------------------------

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

function getEnv(key: string): string | undefined {
  if (typeof Deno !== "undefined" && Deno?.env?.get) {
    return Deno.env.get(key);
  }
  if (typeof process !== "undefined" && process?.env) {
    return process.env[key];
  }
  return undefined;
}

async function getEncryptionKey(): Promise<CryptoKey> {
  const secret = getEnv("GOOGLE_CALENDAR_ENCRYPTION_KEY");
  if (!secret) {
    throw new Error(
      "Missing GOOGLE_CALENDAR_ENCRYPTION_KEY environment secret. " +
      "Set this secret in your Supabase project before using calendar encryption.",
    );
  }

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("gopratle-calendar-salt-v1"),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a plaintext token using AES-256-GCM.
 * Returns formatted string: ivHex:cipherHex
 */
async function encryptToken(plainText: string): Promise<string> {
  if (!plainText) return "";
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plainText),
  );

  const ivHex = Array.from(iv)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const cipherHex = Array.from(new Uint8Array(encryptedBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `${ivHex}:${cipherHex}`;
}

function isDevelopmentMode(): boolean {
  const env =
    Deno.env.get("ENVIRONMENT") ||
    Deno.env.get("DENO_ENV") ||
    Deno.env.get("NODE_ENV");
  const allowLocalhost = Deno.env.get("ALLOW_LOCALHOST_REDIRECTS");
  return (
    env?.toLowerCase() === "development" ||
    allowLocalhost?.toLowerCase() === "true"
  );
}

/**
 * Validate return_url against an allowlist of permitted CRM frontend origins.
 *
 * Rules:
 * 1. Localhost and 127.0.0.1 are ONLY allowed when development mode is explicitly enabled.
 * 2. In production / non-dev, only CRM_FRONTEND_URL and origins in ALLOWED_REDIRECT_ORIGINS are permitted.
 * 3. Any untrusted, unrecognized, or invalid return_url is rejected and falls back to defaultFrontendUrl.
 */
function validateReturnUrl(url: string, defaultFrontendUrl: string): string {
  const crmFrontendUrl = Deno.env.get("CRM_FRONTEND_URL");
  const fallbackUrl = defaultFrontendUrl || crmFrontendUrl || "http://localhost:5173";

  if (!url || typeof url !== "string") {
    return fallbackUrl;
  }

  try {
    const parsed = new URL(url);
    const isDev = isDevelopmentMode();

    // Only allow localhost in explicitly enabled development mode
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      if (isDev) {
        return url;
      }
      console.warn(`Rejected localhost return_url in production/non-dev mode: ${parsed.origin}`);
      return fallbackUrl;
    }

    const allowedOrigins = new Set<string>();
    if (crmFrontendUrl) {
      try {
        allowedOrigins.add(new URL(crmFrontendUrl).origin);
      } catch {
        // invalid
      }
    }

    const additionalOrigins = Deno.env.get("ALLOWED_REDIRECT_ORIGINS");
    if (additionalOrigins) {
      for (const origin of additionalOrigins.split(",")) {
        const trimmed = origin.trim();
        if (trimmed) {
          try {
            allowedOrigins.add(new URL(trimmed).origin);
          } catch {
            // invalid
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

function appendQueryParam(baseUrl: string, key: string, value: string): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set(key, value);
    return url.toString();
  } catch {
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

// -----------------------------------------------------------------------------
// Main Handler (NOTE: JWT verification MUST BE OFF for this endpoint)
// -----------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  const defaultFrontendUrl =
    Deno.env.get("CRM_FRONTEND_URL") || "http://localhost:5173";

  // Check state presence
  if (!state) {
    const redirectUrl = appendQueryParam(
      defaultFrontendUrl,
      "calendar_error",
      "missing_state",
    );
    return Response.redirect(redirectUrl, 302);
  }

  // Validate state from database (CSRF validation)
  const { data: oauthState, error: stateDbError } = await supabaseAdmin
    .from("google_calendar_oauth_states")
    .select("*")
    .eq("state", state)
    .maybeSingle();

  if (stateDbError || !oauthState) {
    const redirectUrl = appendQueryParam(
      defaultFrontendUrl,
      "calendar_error",
      "invalid_state",
    );
    return Response.redirect(redirectUrl, 302);
  }

  let returnUrl = oauthState.return_url || defaultFrontendUrl;

  // Secondary validation of return_url before redirecting
  returnUrl = validateReturnUrl(returnUrl, defaultFrontendUrl);

  // Immediately consume the state so it cannot be re-used
  await supabaseAdmin
    .from("google_calendar_oauth_states")
    .delete()
    .eq("state", state);

  // Check state expiration
  if (new Date(oauthState.expires_at) < new Date()) {
    const redirectUrl = appendQueryParam(
      returnUrl,
      "calendar_error",
      "expired_state",
    );
    return Response.redirect(redirectUrl, 302);
  }

  // Handle Google authorization cancellation / errors
  if (error) {
    const redirectUrl = appendQueryParam(
      returnUrl,
      "calendar_error",
      errorDescription || error || "access_denied",
    );
    return Response.redirect(redirectUrl, 302);
  }

  if (!code) {
    const redirectUrl = appendQueryParam(
      returnUrl,
      "calendar_error",
      "missing_code",
    );
    return Response.redirect(redirectUrl, 302);
  }

  // Exchange authorization code for tokens
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const redirectUri =
    Deno.env.get("GOOGLE_CALENDAR_REDIRECT_URI") ||
    `${supabaseUrl}/functions/v1/google-calendar-callback`;

  if (!clientId || !clientSecret) {
    const redirectUrl = appendQueryParam(
      returnUrl,
      "calendar_error",
      "server_configuration_error",
    );
    return Response.redirect(redirectUrl, 302);
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("Google token exchange error status:", tokenResponse.status, errorText);
      const redirectUrl = appendQueryParam(
        returnUrl,
        "calendar_error",
        "token_exchange_failed",
      );
      return Response.redirect(redirectUrl, 302);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;

    // Reject a new connection if Google does not return a usable refresh token
    // and no previous valid refresh token exists in the database
    if (!refreshToken) {
      const { data: existingConn } = await supabaseAdmin
        .from("google_calendar_connections")
        .select("encrypted_refresh_token")
        .eq("user_id", oauthState.user_id)
        .maybeSingle();

      if (existingConn?.encrypted_refresh_token) {
        // Will reuse existing encrypted refresh token
      } else {
        // Reject connection: no refresh token available
        const redirectUrl = appendQueryParam(
          returnUrl,
          "calendar_error",
          "missing_refresh_token",
        );
        return Response.redirect(redirectUrl, 302);
      }
    }

    // Retrieve the user's primary calendar details / email
    let calendarEmail: string | null = null;
    try {
      const calRes = await fetch(
        "https://www.googleapis.com/calendar/v3/users/me/calendarList/primary",
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (calRes.ok) {
        const calData = await calRes.json();
        calendarEmail = calData.id || calData.summary || null;
      }
    } catch {
      // Non-fatal if calendar info lookup fails
    }

    // Encrypt tokens before storing in database (AES-256-GCM hex colon format)
    const encryptedAccessToken = await encryptToken(accessToken);
    let encryptedRefreshToken = "";

    if (refreshToken) {
      encryptedRefreshToken = await encryptToken(refreshToken);
    } else {
      const { data: existingConn } = await supabaseAdmin
        .from("google_calendar_connections")
        .select("encrypted_refresh_token")
        .eq("user_id", oauthState.user_id)
        .single();
      encryptedRefreshToken = existingConn.encrypted_refresh_token;
    }

    if (!encryptedRefreshToken) {
      const redirectUrl = appendQueryParam(
        returnUrl,
        "calendar_error",
        "missing_refresh_token",
      );
      return Response.redirect(redirectUrl, 302);
    }

    const expiresIn = tokenData.expires_in || 3600;
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // Store encrypted connection in database
    const { error: upsertError } = await supabaseAdmin
      .from("google_calendar_connections")
      .upsert(
        {
          user_id: oauthState.user_id,
          sales_id: oauthState.sales_id,
          calendar_email: calendarEmail,
          encrypted_access_token: encryptedAccessToken,
          encrypted_refresh_token: encryptedRefreshToken,
          token_expires_at: tokenExpiresAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );

    if (upsertError) {
      console.error("Database connection save error:", upsertError.message);
      const redirectUrl = appendQueryParam(
        returnUrl,
        "calendar_error",
        "save_connection_failed",
      );
      return Response.redirect(redirectUrl, 302);
    }

    // Redirect to frontend with success parameter
    const successUrl = appendQueryParam(
      returnUrl,
      "calendar_connected",
      "true",
    );
    return Response.redirect(successUrl, 302);
  } catch (err) {
    console.error("Callback exception occurred:", err);
    const redirectUrl = appendQueryParam(
      returnUrl,
      "calendar_error",
      "unexpected_error",
    );
    return Response.redirect(redirectUrl, 302);
  }
});
