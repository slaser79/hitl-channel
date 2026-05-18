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
      attachment_count: 0,
      attachment_bytes: 0,
    };
    expect(evt.direction).toBe("cc_calls_phone");
    expect(evt.kind).toBe("tool_call");
    expect(evt.tool_name).toBe("list_events");
    expect(evt.approval).toBeNull();
    expect(evt.duration_ms).toBeNull();
    expect(evt.attachment_count).toBe(0);
    expect(evt.attachment_bytes).toBe(0);

    const resultEvt: AuditEvent = {
      ...evt,
      direction: "phone_returns_to_cc",
      kind: "tool_result",
      approval: "user_approved",
      duration_ms: 1234,
      attachment_count: 2,
      attachment_bytes: 4_096,
    };
    expect(resultEvt.approval).toBe("user_approved");
    expect(resultEvt.duration_ms).toBe(1234);
    expect(resultEvt.attachment_count).toBe(2);
    expect(resultEvt.attachment_bytes).toBe(4_096);
  });
});
