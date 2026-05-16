import { describe, expect, it } from "bun:test";
import { sha256Hex, type AuditEvent } from "../audit.js";

describe("audit.ts", () => {
  it("sha256Hex returns a stable 64-char hex digest", () => {
    const h1 = sha256Hex("hello");
    const h2 = sha256Hex("hello");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AuditEvent shape: closed-enum fields accept the spec values", () => {
    // Compile-time + runtime sanity: a value built from the spec's closed
    // enums must satisfy the AuditEvent contract.
    const evt: AuditEvent = {
      ts: new Date("2026-05-16T12:00:00.000Z").toISOString(),
      instance_id: "abc-123",
      direction: "cc_calls_phone",
      kind: "tool_call",
      tool_name: "list_events",
      approval: null,
      prompt_hash: sha256Hex("{}"),
      duration_ms: null,
    };
    expect(evt.direction).toBe("cc_calls_phone");
    expect(evt.kind).toBe("tool_call");
    expect(evt.tool_name).toBe("list_events");
    expect(evt.approval).toBeNull();
    expect(evt.duration_ms).toBeNull();

    const resultEvt: AuditEvent = {
      ...evt,
      direction: "phone_returns_to_cc",
      kind: "tool_result",
      approval: "user_approved",
      duration_ms: 1234,
    };
    expect(resultEvt.approval).toBe("user_approved");
    expect(resultEvt.duration_ms).toBe(1234);
  });
});
