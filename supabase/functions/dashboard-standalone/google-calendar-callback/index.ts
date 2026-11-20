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

const PBKDF2_SALT = new TextEncoder().encode("gopratle-calendar-token-salt-v1");
const PBKDF2_ITERATIONS = 100000;

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: PBKDF2_SALT,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function getEncryptionSecret(): string {
  const secret = Deno.env.get("GOOGLE_CALENDAR_ENCRYPTION_KEY");
  if (!secret) {
    throw new Error(
      "Missing GOOGLE_CALENDAR_ENCRYPTION_KEY environment secret.",
    );
  }
  return secret;
}

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function encryptToken(plainText: string): Promise<string> {
  if (!plainText) return "";
  const secret = getEncryptionSecret();
  const key = await deriveAesKey(secret);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encodedPlain = new TextEncoder().encode(plainText);

  const cipherBuffer = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    encodedPlain,
  );

  const combined = new Uint8Array(iv.length + cipherBuffer.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuffer), iv.length);

  return arrayBufferToBase64(combined);
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

  const returnUrl = oauthState.return_url || defaultFrontendUrl;

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
      const errText = await tokenResponse.text();
      console.error("Token exchange failed:", errText);
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
    const expiresIn = tokenData.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // Verify calendar access and fetch user primary calendar info
    let calendarEmail = "";
    try {
      const calRes = await fetch(
        "https://www.googleapis.com/calendar/v3/users/me/calendarList/primary",
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (calRes.ok) {
        const calData = await calRes.json();
        calendarEmail = calData.id || calData.summary || "";
      }
    } catch (e) {
      console.error("Failed to fetch primary calendar info:", e);
    }

    // Encrypt tokens before storing
    const encryptedAccessToken = await encryptToken(accessToken);
    let encryptedRefreshToken = "";

    if (refreshToken) {
      encryptedRefreshToken = await encryptToken(refreshToken);
    } else {
      // Check existing connection if refresh_token was not re-sent by Google
      const { data: existingConn } = await supabaseAdmin
        .from("google_calendar_connections")
        .select("encrypted_refresh_token")
        .eq("user_id", oauthState.user_id)
        .maybeSingle();

      if (existingConn?.encrypted_refresh_token) {
        encryptedRefreshToken = existingConn.encrypted_refresh_token;
      }
    }

    if (!encryptedRefreshToken) {
      console.warn("No refresh token received and none on file");
    }

    // Upsert into google_calendar_connections
    const { error: upsertError } = await supabaseAdmin
      .from("google_calendar_connections")
      .upsert(
        {
          user_id: oauthState.user_id,
          sales_id: oauthState.sales_id,
          calendar_email: calendarEmail || null,
          encrypted_access_token: encryptedAccessToken,
          encrypted_refresh_token: encryptedRefreshToken,
          token_expires_at: expiresAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );

    if (upsertError) {
      console.error("Failed to store connection:", upsertError);
      const redirectUrl = appendQueryParam(
        returnUrl,
        "calendar_error",
        "database_store_failed",
      );
      return Response.redirect(redirectUrl, 302);
    }

    const redirectUrl = appendQueryParam(
      returnUrl,
      "calendar_connected",
      "success",
    );
    return Response.redirect(redirectUrl, 302);
  } catch (err: any) {
    console.error("OAuth callback error:", err);
    const redirectUrl = appendQueryParam(
      returnUrl,
      "calendar_error",
      encodeURIComponent(err.message || "unexpected_error"),
    );
    return Response.redirect(redirectUrl, 302);
  }
});
