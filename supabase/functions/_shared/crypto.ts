// AES-256-GCM Encryption / Decryption using Web Crypto API

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
export async function encryptToken(plainText: string): Promise<string> {
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

/**
 * Decrypt a token previously encrypted with encryptToken.
 */
export async function decryptToken(encryptedString: string): Promise<string> {
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
