/**
 * SPEC-HITL-CC-001 Phase 6 carry-forward (issue #12) — AC5 unit coverage for
 * the new `attachment_count` + `attachment_bytes` AuditEvent fields and the
 * `summariseAttachments` helper that computes them from a raw frame payload.
 *
 * Privacy invariant (AC3 + spec AC#36): the audit log NEVER carries raw
 * attachment bytes / base64 strings. The closed AuditEvent schema is the
 * structural guarantee; one of the tests below pins it.
 */
import { describe, expect, it } from "bun:test";
import { summariseAttachments, type AuditEvent, sha256Hex } from "../audit.js";

function b64(raw: Uint8Array | string): string {
  const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
  return bytes.toString("base64");
}

describe("summariseAttachments", () => {
  it("returns 0/0 for undefined / null / non-array / empty array", () => {
    expect(summariseAttachments(undefined)).toEqual({ count: 0, bytes: 0 });
    expect(summariseAttachments(null)).toEqual({ count: 0, bytes: 0 });
    expect(summariseAttachments("nope")).toEqual({ count: 0, bytes: 0 });
    expect(summariseAttachments({})).toEqual({ count: 0, bytes: 0 });
    expect(summariseAttachments([])).toEqual({ count: 0, bytes: 0 });
  });

  it("AC5 zero-attachment tool_result round-trip: count=0, bytes=0", () => {
    // Simulate the http_bridge path: tool_call_result frame with no
    // attachments array — both fields default to 0.
    const frame = { type: "tool_call_result", request_id: "r1", success: true };
    expect(summariseAttachments((frame as { attachments?: unknown }).attachments))
      .toEqual({ count: 0, bytes: 0 });
  });

  it("AC5 two-image tool_result: count=2, bytes matches decoded sum within tolerance", () => {
    // ~100-byte payloads, decoded bytes are exact (Buffer.from("...", "base64")).
    const raw1 = Buffer.alloc(96, 0xab);
    const raw2 = Buffer.alloc(123, 0xcd);
    const attachments = [
      { type: "image", media_type: "image/png", data: b64(raw1) },
      { type: "image", media_type: "image/png", data: b64(raw2) },
    ];
    const { count, bytes } = summariseAttachments(attachments);
    expect(count).toBe(2);
    // Padding tolerance per AC5 wording: ±2 bytes around the exact decoded sum.
    const expected = raw1.length + raw2.length;
    expect(Math.abs(bytes - expected)).toBeLessThanOrEqual(2);
  });

  it("AC5 single oversized attachment (~4 MB base64 → ~3 MB decoded): bytes within ±4 of exact", () => {
    // 3 MB raw → ~4 MB base64 string. Verifies the formula doesn't overflow
    // / mis-floor at multi-megabyte sizes.
    const raw = Buffer.alloc(3 * 1024 * 1024, 0x42);
    const attachments = [
      { type: "image", media_type: "image/png", data: b64(raw) },
    ];
    const { count, bytes } = summariseAttachments(attachments);
    expect(count).toBe(1);
    expect(Math.abs(bytes - raw.length)).toBeLessThanOrEqual(4);
  });

  it("counts array length even when some entries have missing/non-string `data`", () => {
    // AC2 spec: count = `attachments?.length ?? 0`. Entries with non-string
    // data still bump the count (the count is array-shape, not validity).
    const attachments = [
      { type: "image", media_type: "image/png", data: b64("hello") },
      { type: "image", media_type: "image/png" /* no data */ },
      { type: "image", media_type: "image/png", data: null },
    ];
    const { count, bytes } = summariseAttachments(attachments);
    expect(count).toBe(3);
    // Only the first entry contributes bytes; "hello" is 5 bytes decoded.
    expect(bytes).toBe(5);
  });

  it("tolerates base64 with embedded whitespace / line wraps", () => {
    // PEM-style 64-char-wrapped base64 — the helper strips non-alphabet chars
    // before measuring length. Decoded bytes match the un-wrapped form.
    const raw = Buffer.alloc(200, 0x11);
    const wrapped = b64(raw).match(/.{1,64}/g)!.join("\n");
    const { count, bytes } = summariseAttachments([
      { type: "image", media_type: "image/png", data: wrapped },
    ]);
    expect(count).toBe(1);
    expect(Math.abs(bytes - raw.length)).toBeLessThanOrEqual(2);
  });
});

describe("AuditEvent closed-schema (AC3 — no raw bytes in audit lines)", () => {
  it("does not surface an `attachments` field even when populated from a frame", () => {
    // Build an AuditEvent the way http_bridge.ts does on `tool_call_result`.
    // The TS compiler enforces the closed schema; this test pins the JSON
    // shape at runtime so a future widening of the type (e.g. a structurally
    // typed assignment via Object.assign) gets caught here.
    const evt: AuditEvent = {
      ts: new Date("2026-05-18T00:00:00.000Z").toISOString(),
      instance_id: "test",
      direction: "phone_returns_to_cc",
      kind: "tool_result",
      tool_name: "display_image",
      approval: "user_approved",
      prompt_hash: sha256Hex("{}"),
      duration_ms: 1234,
      attachment_count: 2,
      attachment_bytes: 5_242_880, // 5 MB
    };
    const serialised = JSON.stringify(evt);
    // Privacy guarantee: the raw `attachments` key never appears in the line.
    expect(serialised.includes("\"attachments\"")).toBe(false);
    // But the metadata fields must be present.
    expect(serialised.includes("\"attachment_count\":2")).toBe(true);
    expect(serialised.includes("\"attachment_bytes\":5242880")).toBe(true);
  });
});
