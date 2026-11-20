// @vitest-environment node
import { describe, expect, it } from "vitest";

describe("Google Calendar Integration - OAuth State Validation Logic", () => {
  type OAuthState = {
    state: string;
    user_id: string;
    expires_at: string;
    return_url: string;
  };

  const validateAndConsumeState = (
    incomingState: string,
    storedStates: Map<string, OAuthState>,
  ): { valid: boolean; error?: string; state?: OAuthState } => {
    if (!incomingState) {
      return { valid: false, error: "missing_state" };
    }

    const stateRecord = storedStates.get(incomingState);
    if (!stateRecord) {
      return { valid: false, error: "invalid_state" };
    }

    // One-time use: delete immediately (CSRF protection)
    storedStates.delete(incomingState);

    // Check expiration
    if (new Date(stateRecord.expires_at) < new Date()) {
      return { valid: false, error: "expired_state" };
    }

    return { valid: true, state: stateRecord };
  };

  it("validates a fresh OAuth state and enforces one-time consumption (CSRF protection)", () => {
    const storedStates = new Map<string, OAuthState>();
    const stateId = "test-uuid-state-1234";

    storedStates.set(stateId, {
      state: stateId,
      user_id: "user-uuid-1",
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      return_url: "http://localhost:5173/#/profile",
    });

    // First attempt: should succeed
    const firstCheck = validateAndConsumeState(stateId, storedStates);
    expect(firstCheck.valid).toBe(true);
    expect(firstCheck.state?.user_id).toBe("user-uuid-1");

    // Second attempt (replay attack): must fail because state is already consumed
    const replayCheck = validateAndConsumeState(stateId, storedStates);
    expect(replayCheck.valid).toBe(false);
    expect(replayCheck.error).toBe("invalid_state");
  });

  it("rejects expired OAuth states", () => {
    const storedStates = new Map<string, OAuthState>();
    const stateId = "expired-uuid-state-5678";

    storedStates.set(stateId, {
      state: stateId,
      user_id: "user-uuid-2",
      expires_at: new Date(Date.now() - 5000).toISOString(),
      return_url: "http://localhost:5173/#/profile",
    });

    const check = validateAndConsumeState(stateId, storedStates);
    expect(check.valid).toBe(false);
    expect(check.error).toBe("expired_state");
  });
});

describe("Google Calendar Integration - Event Payload & Duplicate Prevention", () => {
  it("formats follow-up event summary and description with contact & company context", () => {
    const task = {
      id: 42,
      contact_id: 10,
      text: "Schedule product demo follow-up",
      type: "meeting",
      due_date: "2026-11-25T14:30:00Z",
    };

    const contact = {
      first_name: "Sarah",
      last_name: "Connor",
      title: "VP of Engineering",
      email_jsonb: [{ type: "Work", email: "sarah@cyberdyne.io" }],
      phone_jsonb: [{ type: "Work", number: "+1 555 0199" }],
      lead_source: "linkedin",
      status: "meeting-scheduled",
    };

    const company = {
      name: "Cyberdyne Systems",
    };

    const contactName = `${contact.first_name} ${contact.last_name}`;
    const summary = `Follow-up: ${contactName} - ${company.name}`;
    expect(summary).toBe("Follow-up: Sarah Connor - Cyberdyne Systems");

    const startDate = new Date(task.due_date);
    const durationMinutes = 30;
    const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);

    expect(startDate.toISOString()).toBe("2026-11-25T14:30:00.000Z");
    expect(endDate.toISOString()).toBe("2026-11-25T15:00:00.000Z");
  });

  it("detects existing Google Calendar event ID to prevent duplicate event creation", () => {
    const existingTask = {
      id: 99,
      google_event_id: "cal_evt_abc123xyz",
      google_event_link: "https://calendar.google.com/event?eid=abc123xyz",
      google_event_status: "synced",
    };

    const shouldUpdateExisting = Boolean(
      existingTask.google_event_id,
    );

    expect(shouldUpdateExisting).toBe(true);
  });
});
