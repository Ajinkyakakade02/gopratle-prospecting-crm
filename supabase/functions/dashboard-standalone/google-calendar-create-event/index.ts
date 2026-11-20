import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as jose from "jsr:@panva/jose@6";
import { createClient, type User } from "jsr:@supabase/supabase-js@2";

// -----------------------------------------------------------------------------
// Inlined Shared Utilities & AES-256-GCM Encryption for Supabase Dashboard Web UI
// -----------------------------------------------------------------------------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
    throw new Error(`Auth header is not 'Bearer {token}'`);
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

function base64ToArrayBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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

async function decryptToken(cipherBase64: string): Promise<string> {
  if (!cipherBase64) return "";
  const secret = getEncryptionSecret();
  const key = await deriveAesKey(secret);

  const combined = base64ToArrayBuffer(cipherBase64);
  if (combined.length < 13) {
    throw new Error("Invalid cipher payload: insufficient length");
  }

  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const decryptedBuffer = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    data,
  );

  return new TextDecoder().decode(decryptedBuffer);
}

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

// -----------------------------------------------------------------------------
// Main Handler
// -----------------------------------------------------------------------------

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
          `Prospect: ${contactName}`,
          contact?.title ? `Title: ${contact.title}` : null,
          companyName ? `Company: ${companyName}` : null,
          contact?.status ? `Stage: ${contact.status}` : null,
          emails ? `\nEmail(s):\n${emails}` : null,
          phones ? `\nPhone(s):\n${phones}` : null,
          contact?.linkedin_url ? `LinkedIn: ${contact.linkedin_url}` : null,
        ]
          .filter(Boolean)
          .join("\n");

        const calendarEventPayload: any = {
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
            useDefault: false,
            overrides: [
              { method: "popup", minutes: 10 },
              { method: "email", minutes: 30 },
            ],
          },
        };

        // Add attendee if contact has primary email
        if (Array.isArray(contact?.email_jsonb) && contact.email_jsonb.length > 0) {
          const primaryEmail = contact.email_jsonb[0]?.email;
          if (primaryEmail) {
            calendarEventPayload.attendees = [
              {
                email: primaryEmail,
                displayName: contactName,
              },
            ];
          }
        }

        try {
          // Get valid access token (refreshes if needed)
          const accessToken = await getValidAccessToken(connection);

          // Prevent duplicate events: if task already has a google_event_id, update it (PATCH)
          const existingEventId = task.google_event_id;
          let calendarResponse: Response;

          if (existingEventId) {
            calendarResponse = await fetch(
              `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(existingEventId)}`,
              {
                method: "PATCH",
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(calendarEventPayload),
              },
            );

            // If existing event was deleted on Google Calendar (404), fall back to create (POST)
            if (calendarResponse.status === 404) {
              calendarResponse = await fetch(
                "https://www.googleapis.com/calendar/v3/calendars/primary/events",
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(calendarEventPayload),
                },
              );
            }
          } else {
            calendarResponse = await fetch(
              "https://www.googleapis.com/calendar/v3/calendars/primary/events",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(calendarEventPayload),
              },
            );
          }

          if (!calendarResponse.ok) {
            const errorBody = await calendarResponse.text();
            console.error("Google Calendar API error:", calendarResponse.status, errorBody);

            await supabaseAdmin
              .from("tasks")
              .update({
                google_event_status: "failed",
                google_event_error: `Google API error (${calendarResponse.status}): ${errorBody.slice(0, 200)}`,
              })
              .eq("id", taskId);

            return createErrorResponse(
              calendarResponse.status,
              `Google Calendar API returned error: ${calendarResponse.statusText}`,
              { details: errorBody },
            );
          }

          const createdEvent = await calendarResponse.json();
          const googleEventId = createdEvent.id;
          const googleEventLink = createdEvent.htmlLink;

          // Save event ID and link to task
          await supabaseAdmin
            .from("tasks")
            .update({
              google_event_id: googleEventId,
              google_event_link: googleEventLink,
              google_event_status: "synced",
              google_event_error: null,
            })
            .eq("id", taskId);

          return new Response(
            JSON.stringify({
              success: true,
              eventId: googleEventId,
              eventLink: googleEventLink,
              summary: createdEvent.summary,
              start: createdEvent.start,
              end: createdEvent.end,
            }),
            {
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        } catch (err: any) {
          console.error("Error creating Google Calendar event:", err);

          await supabaseAdmin
            .from("tasks")
            .update({
              google_event_status: "failed",
              google_event_error: err?.message || "Unknown error creating calendar event",
            })
            .eq("id", taskId);

          return createErrorResponse(
            500,
            `Failed to create Google Calendar event: ${err?.message || "Internal error"}`,
          );
        }
      }),
    ),
  ),
);
