import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendBufferDrainAudit, pruneOldAuditFiles, sha256Hex, type AuditEvent } from "../audit.js";

describe("audit.ts", () => {
  it("prunes only old audit files in the configured channel home", async () => {
    const auditDir = join(process.env.HITL_CHANNEL_HOME!, "audit");
    const oldLog = join(auditDir, "2026-01-01.jsonl");
    const recentLog = join(auditDir, "2026-02-11.jsonl");
    const now = new Date("2026-02-11T12:00:00Z");
    const old = new Date("2026-01-01T12:00:00Z");
    await mkdir(auditDir, { recursive: true });
    await writeFile(oldLog, "{}\n");
    await writeFile(recentLog, "{}\n");
    await utimes(oldLog, old, old);
    await utimes(recentLog, now, now);

    expect(await pruneOldAuditFiles(now)).toBe(1);
    expect(await Bun.file(oldLog).exists()).toBe(false);
    expect(await Bun.file(recentLog).exists()).toBe(true);
  });

  it("rejects unsafe audit appends and pruning even though audit I/O is best-effort", async () => {
    const channelHome = process.env.HITL_CHANNEL_HOME!;
    const outside = await mkdtemp(join(tmpdir(), "hitl-outside-audit-"));
    process.env.HITL_CHANNEL_HOME = outside;
    try {
      await expect(appendBufferDrainAudit({
        ts: new Date().toISOString(),
        instance_id: "test",
        event: "phone_offline_buffer_drain",
        replies_drained: 1,
        oldest_buffered_seconds: 1,
      })).rejects.toThrow("outside the temporary test directory");
      await expect(pruneOldAuditFiles()).rejects.toThrow("outside the temporary test directory");
    } finally {
      process.env.HITL_CHANNEL_HOME = channelHome;
      await rm(outside, { recursive: true, force: true });
    }
  });

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

  it("AuditKind accepts the new SPEC-HC-004 `questions_batch` variant", () => {
    const evt: AuditEvent = {
      ts: new Date("2026-05-20T00:00:00.000Z").toISOString(),
      instance_id: "abc-123",
      direction: "cc_to_phone",
      kind: "questions_batch",
      tool_name: null,
      approval: null,
      prompt_hash: sha256Hex("[]"),
      duration_ms: null,
      attachment_count: 0,
      attachment_bytes: 0,
    };
    expect(evt.kind).toBe("questions_batch");
  });
});
