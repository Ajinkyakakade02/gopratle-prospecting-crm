import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { encryptToken } from "../_shared/crypto.ts";

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
      const errorText = await tokenResponse.text();
      console.error("Google token exchange error status:", tokenResponse.status);
      const redirectUrl = appendQueryParam(
        returnUrl,
        "calendar_error",
        "token_exchange_failed",
      );
      return Response.redirect(redirectUrl, 302);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    let refreshToken = tokenData.refresh_token;

    // If Google didn't return a refresh_token (can happen if user reconnected),
    // retain the existing encrypted refresh token if available
    if (!refreshToken) {
      const { data: existingConn } = await supabaseAdmin
        .from("google_calendar_connections")
        .select("encrypted_refresh_token")
        .eq("user_id", oauthState.user_id)
        .maybeSingle();

      if (existingConn?.encrypted_refresh_token) {
        // Will reuse existing encrypted refresh token
      } else {
        // Prompt user to reconnect with consent prompt
        const redirectUrl = appendQueryParam(
          returnUrl,
          "calendar_error",
          "missing_refresh_token",
        );
        return Response.redirect(redirectUrl, 302);
      }
    }

    // Retrieve the user's primary calendar details / email
    let calendarEmail = null;
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

    // Encrypt tokens before storing in database
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
    console.error("Callback exception occurred");
    const redirectUrl = appendQueryParam(
      returnUrl,
      "calendar_error",
      "unexpected_error",
    );
    return Response.redirect(redirectUrl, 302);
  }
});
