// @vitest-environment node
import { describe, it, expect } from "vitest";
import { encryptToken, decryptToken } from "./crypto.ts";

describe("Edge Functions Crypto - AES-256-GCM Token Encryption", () => {
  it("encrypts and decrypts a sensitive token successfully", async () => {
    const rawToken = "ya29.sample-google-oauth-access-token-123456789";
    const encrypted = await encryptToken(rawToken);

    // Format should be ivHex:cipherHex
    expect(encrypted).toContain(":");
    expect(encrypted).not.toEqual(rawToken);

    // Decrypt
    const decrypted = await decryptToken(encrypted);
    expect(decrypted).toEqual(rawToken);
  });

  it("produces unique ciphertexts on each encryption of the same value", async () => {
    const token = "refresh-token-12345";
    const enc1 = await encryptToken(token);
    const enc2 = await encryptToken(token);

    expect(enc1).not.toEqual(enc2);
    expect(await decryptToken(enc1)).toEqual(token);
    expect(await decryptToken(enc2)).toEqual(token);
  });

  it("throws on invalid ciphertext format", async () => {
    await expect(decryptToken("invalid-ciphertext-without-colon")).rejects.toThrow();
  });
});
