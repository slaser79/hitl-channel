/**
 * Append-only JSONL audit log per SPEC-HITL-CC-001 §4.2.
 *
 * - One file per UTC day: `~/.hitl/channels/audit/<YYYY-MM-DD>.jsonl`.
 * - Closed schema enforced via the `AuditEvent` type.
 * - 30-day local retention with oldest-first prune at startup. Pruning is
 *   best-effort and non-blocking.
 */

import { homedir } from "node:os";
import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const AUDIT_DIR = join(homedir(), ".hitl", "channels", "audit");
const RETENTION_DAYS = 30;

export type AuditDirection =
  | "phone_to_cc"
  | "cc_to_phone"
  | "cc_calls_phone"
  | "phone_returns_to_cc";

export type AuditKind =
  | "message"
  | "pairing_request"
  | "bootstrap"
  | "reply"
  | "choices"
  | "tool_call"
  | "tool_result";

export type AuditApproval =
  | "auto"
  | "user_approved"
  | "user_denied"
  | "timeout"
  | null;

export interface AuditEvent {
  ts: string;                    // ISO-8601 UTC
  instance_id: string;
  direction: AuditDirection;
  kind: AuditKind;
  tool_name: string | null;      // null unless kind ∈ {tool_call, tool_result}
  approval: AuditApproval;       // null unless kind === 'tool_result'
  prompt_hash: string;           // SHA-256 hex of content / JSON.stringify(arguments)
  duration_ms: number | null;    // null unless this is an outbound result
}

function utcDateStamp(date = new Date()): string {
  // YYYY-MM-DD in UTC, no time component.
  return date.toISOString().slice(0, 10);
}

function fileForDate(date = new Date()): string {
  return join(AUDIT_DIR, `${utcDateStamp(date)}.jsonl`);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Append one event line. Errors are swallowed and logged to stderr — audit
 * IO must never block the WS path.
 */
export async function appendAudit(event: AuditEvent): Promise<void> {
  try {
    await mkdir(AUDIT_DIR, { recursive: true });
    const line = JSON.stringify(event) + "\n";
    await appendFile(fileForDate(), line, { encoding: "utf8" });
  } catch (err) {
    process.stderr.write(
      `[hitl-channel] audit append failed: ${err instanceof Error ? err.message : err}\n`
    );
  }
}

/**
 * Oldest-first prune of audit files older than RETENTION_DAYS. Best-effort —
 * any failure is logged but does not block startup. Returns the number of
 * files deleted (useful for tests).
 */
export async function pruneOldAuditFiles(now = new Date()): Promise<number> {
  try {
    await mkdir(AUDIT_DIR, { recursive: true });
    const entries = await readdir(AUDIT_DIR);
    const cutoffMs = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let deleted = 0;
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = join(AUDIT_DIR, name);
      try {
        const st = await stat(filePath);
        if (st.mtimeMs < cutoffMs) {
          await rm(filePath);
          deleted++;
          process.stderr.write(`[hitl-channel] audit pruned ${name}\n`);
        }
      } catch (err) {
        process.stderr.write(
          `[hitl-channel] audit prune skip ${name}: ${err instanceof Error ? err.message : err}\n`
        );
      }
    }
    return deleted;
  } catch (err) {
    process.stderr.write(
      `[hitl-channel] audit prune failed: ${err instanceof Error ? err.message : err}\n`
    );
    return 0;
  }
}

/** Test helper: expose the resolved audit dir. */
export const auditDir = AUDIT_DIR;
