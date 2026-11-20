import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { createErrorResponse } from "../_shared/utils.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { AuthMiddleware, UserMiddleware } from "../_shared/authentication.ts";
import { getUserSale } from "../_shared/getUserSale.ts";
import { decryptToken, encryptToken } from "../_shared/crypto.ts";

async function getValidAccessToken(connection: any): Promise<string> {
  const now = new Date();
  const expiresAt = connection.token_expires_at
    ? new Date(connection.token_expires_at)
    : null;

  const accessToken = await decryptToken(connection.encrypted_access_token);
  const refreshToken = await decryptToken(connection.encrypted_refresh_token);

  // If token is valid for at least another 2 minutes, return it directly
  if (expiresAt && expiresAt.getTime() - now.getTime() > 120 * 1000) {
    return accessToken;
  }

  // Token is expired or expiring soon; refresh it
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error("Missing Google OAuth credentials in environment");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh Google token (${response.status}): ${errorText}`);
  }

  const tokenData = await response.json();
  const newAccessToken = tokenData.access_token;
  const expiresIn = tokenData.expires_in || 3600;
  const newExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  const encryptedNewAccessToken = await encryptToken(newAccessToken);
  let encryptedNewRefreshToken = connection.encrypted_refresh_token;

  if (tokenData.refresh_token) {
    encryptedNewRefreshToken = await encryptToken(tokenData.refresh_token);
  }

  // Update connection with refreshed token
  await supabaseAdmin
    .from("google_calendar_connections")
    .update({
      encrypted_access_token: encryptedNewAccessToken,
      encrypted_refresh_token: encryptedNewRefreshToken,
      token_expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connection.id);

  return newAccessToken;
}

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

        let body: any;
        try {
          body = await req.json();
        } catch {
          return createErrorResponse(400, "Invalid JSON body");
        }

        const taskId = body?.taskId;
        if (!taskId) {
          return createErrorResponse(400, "taskId is required");
        }

        const durationMinutes = Number(body?.durationMinutes) || 30;
        const timezone = body?.timezone || "Asia/Kolkata";

        // Fetch task
        const { data: task, error: taskError } = await supabaseAdmin
          .from("tasks")
          .select("*")
          .eq("id", taskId)
          .maybeSingle();

        if (taskError || !task) {
          return createErrorResponse(404, `Task with ID ${taskId} not found`);
        }

        // Task ownership check: verify the task belongs to the authenticated user
        const sale = await getUserSale(user);
        if (!sale) {
          return createErrorResponse(404, "Sales profile not found for user");
        }
        if (task.sales_id !== sale.id) {
          return createErrorResponse(403, "You are not authorized to sync this task to Google Calendar");
        }

        // Fetch Google Calendar connection for this user
        const { data: connection, error: connError } = await supabaseAdmin
          .from("google_calendar_connections")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle();

        if (connError || !connection) {
          await supabaseAdmin
            .from("tasks")
            .update({
              google_event_status: "failed",
              google_event_error: "Google Calendar is not connected",
            })
            .eq("id", taskId);

          return createErrorResponse(
            400,
            "Google Calendar is not connected. Please connect your calendar first.",
          );
        }

        // Fetch contact details
        const { data: contact } = await supabaseAdmin
          .from("contacts")
          .select("*")
          .eq("id", task.contact_id)
          .maybeSingle();

        // Fetch company details if applicable
        let company: any = null;
        if (contact?.company_id) {
          const { data: companyData } = await supabaseAdmin
            .from("companies")
            .select("id, name")
            .eq("id", contact.company_id)
            .maybeSingle();
          company = companyData;
        }

        // Calculate start and end date
        const startDate = task.due_date ? new Date(task.due_date) : new Date();
        const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);

        // Build contact information strings
        const contactName = contact
          ? `${contact.first_name || ""} ${contact.last_name || ""}`.trim()
          : "Prospect";
        const companyName = company?.name || "";

        // Build event summary
        const summary = `Follow-up: ${contactName}${companyName ? ` - ${companyName}` : ""}`;

        // Format emails and phones for description
        const emails = Array.isArray(contact?.email_jsonb)
          ? contact.email_jsonb
              .map((e: any) => `${e.type || "Email"}: ${e.email}`)
              .join("\n")
          : "";

        const phones = Array.isArray(contact?.phone_jsonb)
          ? contact.phone_jsonb
              .map((p: any) => `${p.type || "Phone"}: ${p.number}`)
              .join("\n")
          : "";

        const description = [
          `GoPratle Prospecting CRM - Follow-up Task`,
          ``,
          `Task: ${task.text || "Scheduled Follow-up"}`,
          `Type: ${task.type || "follow-up"}`,
          `Contact: ${contactName}`,
          contact?.title ? `Role: ${contact.title}` : "",
          companyName ? `Company: ${companyName}` : "",
          contact?.lead_source ? `Lead Source: ${contact.lead_source}` : "",
          contact?.status ? `Pipeline Stage: ${contact.status}` : "",
          contact?.linkedin_url ? `LinkedIn: ${contact.linkedin_url}` : "",
          emails ? `\nEmail Details:\n${emails}` : "",
          phones ? `\nPhone Details:\n${phones}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        try {
          const accessToken = await getValidAccessToken(connection);

          const eventPayload = {
            summary,
            description,
            start: {
              dateTime: startDate.toISOString(),
              timeZone: timezone,
            },
            end: {
              dateTime: endDate.toISOString(),
              timeZone: timezone,
            },
            reminders: {
              useDefault: true,
            },
          };

          let calRes: Response;
          // Duplicate prevention / idempotent update:
          // If task already has a google_event_id, update it via PATCH instead of creating a duplicate
          if (task.google_event_id) {
            calRes = await fetch(
              `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(task.google_event_id)}`,
              {
                method: "PATCH",
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(eventPayload),
              },
            );

            // If existing event was deleted on Google's side (404/410), fall back to creating a new one
            if (calRes.status === 404 || calRes.status === 410) {
              calRes = await fetch(
                "https://www.googleapis.com/calendar/v3/calendars/primary/events",
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(eventPayload),
                },
              );
            }
          } else {
            calRes = await fetch(
              "https://www.googleapis.com/calendar/v3/calendars/primary/events",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(eventPayload),
              },
            );
          }

          if (!calRes.ok) {
            const errorBody = await calRes.text();
            console.error("Google Calendar API error status:", calRes.status);

            await supabaseAdmin
              .from("tasks")
              .update({
                google_event_status: "failed",
                google_event_error: `Google Calendar API error (${calRes.status})`,
              })
              .eq("id", taskId);

            return createErrorResponse(
              500,
              `Google Calendar API rejected event creation: ${errorBody}`,
            );
          }

          const calData = await calRes.json();
          const eventId = calData.id;
          const eventLink = calData.htmlLink || null;

          // Update task in database with success status
          await supabaseAdmin
            .from("tasks")
            .update({
              google_event_id: eventId,
              google_event_link: eventLink,
              google_event_status: "synced",
              google_event_error: null,
            })
            .eq("id", taskId);

          return new Response(
            JSON.stringify({
              success: true,
              eventId,
              eventLink,
              message: "Google Calendar event created successfully",
            }),
            {
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        } catch (error: any) {
          console.error("Error creating Google Calendar event:", error?.message);

          await supabaseAdmin
            .from("tasks")
            .update({
              google_event_status: "failed",
              google_event_error: error?.message || "Internal error",
            })
            .eq("id", taskId);

          return createErrorResponse(
            500,
            `Failed to create Google Calendar event: ${error?.message || "Unknown error"}`,
          );
        }
      }),
    ),
  ),
);
