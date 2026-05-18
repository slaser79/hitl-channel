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
  // SPEC-HITL-CC-001 Phase 6 carry-forward (issue #12) — attachment metadata
  // for `tool_call_result` frames. Required + closed-schema; non-tool-result
  // lines default to 0/0. Inbound `tool_call_request` attachments (the
  // `cc_calls_phone` direction) stay out of scope: no phone tool today
  // consumes a CC-supplied attachment as input, so the count would always
  // be 0. If/when that changes, extract the same way for symmetry.
  attachment_count: number;      // count of attachments on the source frame
  attachment_bytes: number;      // sum of DECODED bytes across attachments
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
 * SPEC-HITL-CC-001 Phase 6 carry-forward (issue #12) — summarise an attachment
 * array for audit emission. Returns `{count, bytes}` where:
 *
 * - `count` is `attachments?.length ?? 0` (zero for missing / non-array).
 * - `bytes` is the sum of DECODED base64 byte lengths across all entries with
 *   a string `data` field. Formula: `floor(len * 3 / 4) - padding`, where
 *   padding is the number of trailing `=` chars (0, 1, or 2). Non-string /
 *   undefined `data` contributes 0.
 *
 * Intentionally tolerant — base64 input that includes whitespace or wraps is
 * normalised by stripping any char outside the base64 alphabet before the
 * length calculation. Audit lines must NEVER carry the raw bytes themselves
 * (closed-schema rule + privacy + log size) — callers extract count/bytes
 * via this helper and discard the original array before calling appendAudit.
 */
export function summariseAttachments(
  attachments: unknown,
): { count: number; bytes: number } {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { count: 0, bytes: 0 };
  }
  let bytes = 0;
  for (const a of attachments) {
    if (!a || typeof a !== "object") continue;
    const data = (a as { data?: unknown }).data;
    if (typeof data !== "string" || data.length === 0) continue;
    // Strip everything outside the base64 alphabet (handles whitespace, CR/LF
    // line wraps, stray characters). Padding `=` is counted separately.
    const normalised = data.replace(/[^A-Za-z0-9+/=]/g, "");
    if (normalised.length === 0) continue;
    let padding = 0;
    if (normalised.endsWith("==")) padding = 2;
    else if (normalised.endsWith("=")) padding = 1;
    bytes += Math.floor((normalised.length * 3) / 4) - padding;
  }
  return { count: attachments.length, bytes };
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
 * SPEC-HITL-CC-001 Phase 4 AC#26 — distinct audit line shape for ReplyBuffer
 * drains. Emitted on each non-empty drain (i.e. when ≥1 buffered reply was
 * replayed to a reconnecting client). Lives in the same daily JSONL file as
 * AuditEvent but uses its own closed schema, discriminated by the `event`
 * field.
 */
export interface BufferDrainAuditLine {
  ts: string;                       // ISO-8601 UTC
  instance_id: string;
  event: "phone_offline_buffer_drain";
  replies_drained: number;          // count of entries replayed
  oldest_buffered_seconds: number;  // floor((now - oldest.queuedAt) / 1000)
}

/**
 * Append one `phone_offline_buffer_drain` line. Same fire-and-forget shape
 * as appendAudit — failures are logged to stderr but never block the WS path.
 */
export async function appendBufferDrainAudit(line: BufferDrainAuditLine): Promise<void> {
  try {
    await mkdir(AUDIT_DIR, { recursive: true });
    const raw = JSON.stringify(line) + "\n";
    await appendFile(fileForDate(), raw, { encoding: "utf8" });
  } catch (err) {
    process.stderr.write(
      `[hitl-channel] buffer-drain audit append failed: ${err instanceof Error ? err.message : err}\n`
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
