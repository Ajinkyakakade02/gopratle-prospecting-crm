import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as jose from "jsr:@panva/jose@6";
import { createClient, type User } from "jsr:@supabase/supabase-js@2";

// -----------------------------------------------------------------------------
// Inlined Shared Utilities for Supabase Dashboard Web UI Deployment
// -----------------------------------------------------------------------------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function OptionsMiddleware(
  req: Request,
  next: (req: Request) => Promise<Response>,
) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return next(req);
}

function createErrorResponse(
  status: number,
  message: string,
  custom: Record<string, unknown> = {},
) {
  return new Response(JSON.stringify({ status, message, ...custom }), {
    headers: { "Content-Type": "application/json", ...corsHeaders },
    status,
  });
}

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

const SUPABASE_JWT_ISSUER =
  Deno.env.get("SB_JWT_ISSUER") ?? Deno.env.get("SUPABASE_URL") + "/auth/v1";

const SUPABASE_JWT_KEYS = jose.createRemoteJWKSet(
  new URL(Deno.env.get("SUPABASE_URL")! + "/auth/v1/.well-known/jwks.json"),
);

function getAuthToken(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    throw new Error("Missing authorization header");
  }
  const [bearer, token] = authHeader.split(" ");
  if (bearer !== "Bearer") {
    throw new Error("Auth header is not 'Bearer {token}'");
  }
  return token;
}

function verifySupabaseJWT(jwt: string) {
  return jose.jwtVerify(jwt, SUPABASE_JWT_KEYS, {
    issuer: SUPABASE_JWT_ISSUER,
  });
}

const AuthMiddleware = async (
  req: Request,
  next: (req: Request) => Promise<Response>,
) => {
  if (req.method === "OPTIONS") return await next(req);
  try {
    const token = getAuthToken(req);
    const isValidJWT = await verifySupabaseJWT(token);
    if (isValidJWT) return await next(req);
    return createErrorResponse(401, "Invalid authentication");
  } catch (e: any) {
    return createErrorResponse(401, e?.toString() || "Unauthorized");
  }
};

const UserMiddleware = async (
  req: Request,
  next: (req: Request, user?: User) => Promise<Response>,
) => {
  if (req.method === "OPTIONS") return await next(req);
  try {
    const authHeader = req.headers.get("Authorization")!;
    const localClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_PUBLISHABLE_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data, error: authError } = await localClient.auth.getUser();
    if (!data?.user || authError) {
      return createErrorResponse(401, "Unauthorized");
    }
    return next(req, data.user);
  } catch (err: any) {
    return createErrorResponse(401, err?.toString() || "Unauthorized");
  }
};

const getUserSale = async (user: User) => {
  return (
    await supabaseAdmin
      .from("sales")
      .select("*")
      .eq("user_id", user.id)
      .single()
  )?.data;
};

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

// -----------------------------------------------------------------------------
// Main Handler
// -----------------------------------------------------------------------------

Deno.serve(async (req: Request) =>
  OptionsMiddleware(req, async (req) =>
    AuthMiddleware(req, async (req) =>
      UserMiddleware(req, async (req, user) => {
        if (!user) {
          return createErrorResponse(401, "User not authenticated");
        }

        const sale = await getUserSale(user);
        if (!sale) {
          return createErrorResponse(404, "Sales profile not found for user");
        }

        const url = new URL(req.url);
        const action = url.searchParams.get("action");

        // Action: check status
        if (req.method === "GET" && action === "status") {
          const { data: connection } = await supabaseAdmin
            .from("google_calendar_connections")
            .select("id, calendar_email, created_at, updated_at")
            .eq("user_id", user.id)
            .maybeSingle();

          return new Response(
            JSON.stringify({
              connected: !!connection,
              calendar_email: connection?.calendar_email || null,
              created_at: connection?.created_at || null,
              updated_at: connection?.updated_at || null,
            }),
            {
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }

        // Action: initiate Google OAuth connection
        const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
        if (!clientId) {
          return createErrorResponse(
            500,
            "Missing GOOGLE_CLIENT_ID configuration on server",
          );
        }

        const supabaseUrl = Deno.env.get("SUPABASE_URL");
        const redirectUri =
          Deno.env.get("GOOGLE_CALENDAR_REDIRECT_URI") ||
          `${supabaseUrl}/functions/v1/google-calendar-callback`;

        // Parse returnUrl from query or body
        let returnUrl = url.searchParams.get("return_url") || "";
        if (req.method === "POST") {
          try {
            const body = await req.json();
            if (body?.return_url) {
              returnUrl = body.return_url;
            }
          } catch {
            // body may be empty
          }
        }

        const defaultFrontendUrl =
          Deno.env.get("CRM_FRONTEND_URL") || "http://localhost:5173";

        if (!returnUrl) {
          returnUrl = defaultFrontendUrl;
        }

        // Validate return_url against an allowlist of permitted origins
        returnUrl = validateReturnUrl(returnUrl, defaultFrontendUrl);

        // Generate cryptographically secure random state (CSRF prevention)
        const state = crypto.randomUUID();

        // Store state with 10-minute expiry
        const { error: stateError } = await supabaseAdmin
          .from("google_calendar_oauth_states")
          .insert({
            state,
            user_id: user.id,
            sales_id: sale.id,
            return_url: returnUrl,
            expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          });

        if (stateError) {
          return createErrorResponse(500, `Failed to initialize OAuth state: ${stateError.message}`);
        }

        const authParams = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "https://www.googleapis.com/auth/calendar.events",
          access_type: "offline",
          prompt: "consent",
          state: state,
        });

        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;

        if (req.method === "POST" || req.headers.get("accept")?.includes("application/json")) {
          return new Response(
            JSON.stringify({
              url: authUrl,
              state: state,
            }),
            {
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }

        return Response.redirect(authUrl, 302);
      }),
    ),
  ),
);
