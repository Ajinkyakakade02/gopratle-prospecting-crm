import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { createErrorResponse } from "../_shared/utils.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { AuthMiddleware, UserMiddleware } from "../_shared/authentication.ts";
import { getUserSale } from "../_shared/getUserSale.ts";
import { validateReturnUrl } from "../_shared/redirectValidation.ts";

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
