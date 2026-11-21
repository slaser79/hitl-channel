import { describe, expect, it } from "bun:test";
import { sha256Hex, type AuditEvent } from "../audit.js";

describe("SPEC-HC-005 Daemon Audit Extensions (AV6, AV8, AV11)", () => {
  it("accepts permission audit events with harness_to_phone direction and non-null tool_name", () => {
    const evt: AuditEvent = {
      ts: new Date("2026-11-21T12:00:00.000Z").toISOString(),
      instance_id: "daemon-agy-1",
      direction: "harness_to_phone",
      kind: "permission",
      tool_name: "mcp_hitl-channel_call_phone_tool",
      approval: "auto",
      prompt_hash: sha256Hex("{}"),
      duration_ms: null,
      attachment_count: 0,
      attachment_bytes: 0,
      acp_session_id: "sess-abc-123",
    };

    expect(evt.direction).toBe("harness_to_phone");
    expect(evt.kind).toBe("permission");
    expect(evt.approval).toBe("auto");
    expect(evt.tool_name).toBe("mcp_hitl-channel_call_phone_tool");
    expect(evt.acp_session_id).toBe("sess-abc-123");
  });

  it("accepts user_approved, user_denied, and cancelled approvals on permission events", () => {
    const approvals: Array<AuditEvent["approval"]> = [
      "auto",
      "user_approved",
      "user_denied",
      "cancelled",
    ];
    for (const approval of approvals) {
      const evt: AuditEvent = {
        ts: new Date("2026-11-21T12:00:00.000Z").toISOString(),
        instance_id: "daemon-agy-1",
        direction: "harness_to_phone",
        kind: "permission",
        tool_name: "bash",
        approval,
        prompt_hash: sha256Hex("ls"),
        duration_ms: null,
        attachment_count: 0,
        attachment_bytes: 0,
        acp_session_id: "sess-1",
      };
      expect(evt.approval).toBe(approval);
      expect(evt.tool_name).not.toBeNull();
    }
  });

  it("channel-mode AuditEvent omits acp_session_id cleanly for byte compatibility", () => {
    const channelEvt: AuditEvent = {
      ts: new Date("2026-11-21T12:00:00.000Z").toISOString(),
      instance_id: "cc-1",
      direction: "phone_to_cc",
      kind: "message",
      tool_name: null,
      approval: null,
      prompt_hash: sha256Hex("hello"),
      duration_ms: null,
      attachment_count: 0,
      attachment_bytes: 0,
    };
    expect("acp_session_id" in channelEvt).toBe(false);
    expect(channelEvt.acp_session_id).toBeUndefined();
  });
});
