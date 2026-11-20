import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { createErrorResponse } from "../_shared/utils.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { AuthMiddleware, UserMiddleware } from "../_shared/authentication.ts";
import { decryptToken } from "../_shared/crypto.ts";

Deno.serve(async (req: Request) =>
  OptionsMiddleware(req, async (req) =>
    AuthMiddleware(req, async (req) =>
      UserMiddleware(req, async (req, user) => {
        if (req.method !== "POST") {
          return createErrorResponse(405, "Method Not Allowed");
        }

        if (!user) {
          return createErrorResponse(401, "Unauthorized");
        }

        // Fetch connection record
        const { data: connection } = await supabaseAdmin
          .from("google_calendar_connections")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle();

        if (connection) {
          // Attempt to revoke with Google
          try {
            const refreshToken = await decryptToken(connection.encrypted_refresh_token);
            if (refreshToken) {
              await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
              });
            }
          } catch {
            // Revocation failure should not block removing connection from CRM
          }

          // Delete connection from database
          const { error: deleteError } = await supabaseAdmin
            .from("google_calendar_connections")
            .delete()
            .eq("user_id", user.id);

          if (deleteError) {
            return createErrorResponse(500, `Failed to remove connection: ${deleteError.message}`);
          }
        }

        return new Response(
          JSON.stringify({
            success: true,
            message: "Google Calendar disconnected successfully",
          }),
          {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          },
        );
      }),
    ),
  ),
);
