import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as jose from "jsr:@panva/jose@6";
import { createClient, type User } from "jsr:@supabase/supabase-js@2";

// -----------------------------------------------------------------------------
// Inlined Shared Utilities & AES-256-GCM Decryption for Supabase Dashboard Web UI
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

function base64ToArrayBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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
