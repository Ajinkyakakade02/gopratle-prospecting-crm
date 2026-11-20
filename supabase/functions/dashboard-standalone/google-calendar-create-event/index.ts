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

const getUserSale = async (user: User) => {
  return (
    await supabaseAdmin
      .from("sales")
      .select("*")
      .eq("user_id", user.id)
      .single()
  )?.data;
};

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

async function decryptToken(encryptedString: string): Promise<string> {
  if (!encryptedString) return "";
  const parts = encryptedString.split(":");
  if (parts.length !== 2) {
    throw new Error("Invalid encrypted token format: expected iv:ciphertext");
  }

  const [ivHex, cipherHex] = parts;
  if (!ivHex || !cipherHex) {
    throw new Error("Invalid encrypted token format: empty components");
  }

  const ivMatches = ivHex.match(/.{1,2}/g);
  const cipherMatches = cipherHex.match(/.{1,2}/g);

  if (!ivMatches || !cipherMatches) {
    throw new Error("Invalid hex characters in encrypted token");
  }

  const iv = new Uint8Array(ivMatches.map((b) => parseInt(b, 16)));
  const cipher = new Uint8Array(cipherMatches.map((b) => parseInt(b, 16)));
  const key = await getEncryptionKey();

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    cipher,
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

        // Ownership check: verify task belongs to authenticated user's sales profile
        const sale = await getUserSale(user);
        if (!sale) {
          return createErrorResponse(404, "Sales profile not found for user");
        }
        if (task.sales_id !== sale.id) {
          return createErrorResponse(
            403,
            "You are not authorized to sync this task to Google Calendar",
          );
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

        // Event payload for internal follow-up reminder (prospects are NOT auto-invited as attendees)
        const eventPayload: any = {
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

        try {
          const accessToken = await getValidAccessToken(connection);

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
