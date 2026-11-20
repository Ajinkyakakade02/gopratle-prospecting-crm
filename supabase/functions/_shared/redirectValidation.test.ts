// @vitest-environment node
import { describe, it, expect } from "vitest";
import { validateReturnUrl, isDevelopmentMode } from "./redirectValidation.ts";

describe("OAuth Redirect Validation Security", () => {
  const prodFrontend = "https://crm.gopratle.com";
  const defaultFallback = "https://crm.gopratle.com/settings";

  describe("Development mode detection", () => {
    it("detects development when ENVIRONMENT is set to development", () => {
      const mockEnv = (k: string) => (k === "ENVIRONMENT" ? "development" : undefined);
      expect(isDevelopmentMode(mockEnv)).toBe(true);
    });

    it("detects development when ALLOW_LOCALHOST_REDIRECTS is true", () => {
      const mockEnv = (k: string) => (k === "ALLOW_LOCALHOST_REDIRECTS" ? "true" : undefined);
      expect(isDevelopmentMode(mockEnv)).toBe(true);
    });

    it("defaults to non-development when env vars are missing or production", () => {
      const mockEnv = (k: string) => (k === "ENVIRONMENT" ? "production" : undefined);
      expect(isDevelopmentMode(mockEnv)).toBe(false);
      expect(isDevelopmentMode(() => undefined)).toBe(false);
    });
  });

  describe("Development mode redirect behavior", () => {
    const mockDevEnv = (k: string) => {
      if (k === "ENVIRONMENT") return "development";
      if (k === "CRM_FRONTEND_URL") return "http://localhost:5173";
      return undefined;
    };

    it("allows localhost and 127.0.0.1 with any port in development mode", () => {
      expect(validateReturnUrl("http://localhost:5173/auth/callback", defaultFallback, mockDevEnv))
        .toBe("http://localhost:5173/auth/callback");
      expect(validateReturnUrl("http://127.0.0.1:3000/callback", defaultFallback, mockDevEnv))
        .toBe("http://127.0.0.1:3000/callback");
    });
  });

  describe("Production mode redirect behavior", () => {
    const mockProdEnv = (k: string) => {
      if (k === "ENVIRONMENT") return "production";
      if (k === "CRM_FRONTEND_URL") return prodFrontend;
      if (k === "ALLOWED_REDIRECT_ORIGINS") return "https://staging.gopratle.com, https://app.gopratle.com";
      return undefined;
    };

    it("strictly rejects localhost and 127.0.0.1 in production", () => {
      expect(validateReturnUrl("http://localhost:5173/profile", defaultFallback, mockProdEnv))
        .toBe(defaultFallback);
      expect(validateReturnUrl("http://127.0.0.1:5173/profile", defaultFallback, mockProdEnv))
        .toBe(defaultFallback);
    });

    it("allows URLs matching CRM_FRONTEND_URL origin in production", () => {
      expect(validateReturnUrl("https://crm.gopratle.com/settings/profile?tab=calendar", defaultFallback, mockProdEnv))
        .toBe("https://crm.gopratle.com/settings/profile?tab=calendar");
    });

    it("allows URLs matching explicitly configured ALLOWED_REDIRECT_ORIGINS", () => {
      expect(validateReturnUrl("https://staging.gopratle.com/auth", defaultFallback, mockProdEnv))
        .toBe("https://staging.gopratle.com/auth");
      expect(validateReturnUrl("https://app.gopratle.com/oauth/return", defaultFallback, mockProdEnv))
        .toBe("https://app.gopratle.com/oauth/return");
    });

    it("rejects untrusted external domains and phishing attempts", () => {
      expect(validateReturnUrl("https://evil-phishing-site.com/steal-token", defaultFallback, mockProdEnv))
        .toBe(defaultFallback);
      expect(validateReturnUrl("https://crm.gopratle.com.attacker.com", defaultFallback, mockProdEnv))
        .toBe(defaultFallback);
    });

    it("gracefully falls back on malformed or empty URLs", () => {
      expect(validateReturnUrl("not-a-valid-url", defaultFallback, mockProdEnv))
        .toBe(defaultFallback);
      expect(validateReturnUrl("", defaultFallback, mockProdEnv))
        .toBe(defaultFallback);
      expect(validateReturnUrl("javascript:alert(1)", defaultFallback, mockProdEnv))
        .toBe(defaultFallback);
    });
  });
});
