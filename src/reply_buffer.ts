/**
 * Per-instance in-memory ring buffer for WS replies queued while no clients
 * are connected. SPEC-HITL-CC-001 Phase 4 AC#26.
 *
 * - Keyed on `agent_id` (empty string when unset).
 * - Bucket cap = 32 (R2). FIFO eviction once a bucket exceeds the cap.
 * - Entry TTL = 24h (R2). Expired entries are dropped at peek/drain time,
 *   never replayed.
 * - In-memory only — daemon restart clears the buffer (acceptable since
 *   hitl-channel runs alongside CC on the user's desktop; restart is rare
 *   and explicit per umbrella issue hitl-app#4043).
 * - Cross-instance isolation: each ReplyBuffer holds its own buckets, so
 *   two daemons (or two test fixtures) never share state.
 *
 * Production delivery via WS uses peek() + per-entry commit() so a WS that
 * drops mid-loop leaves un-sent entries in the buffer for the next reconnect.
 * Tests and shutdown paths can use drain() as a convenience (peek + commit-all).
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { assertTestStatePath, getChannelHome } from "./channel_home.js";
import type { BufferedReply, HostRunEventFrame, ReplyPayload } from "./types.js";

/** SPEC-HITL-CC-001 R2: per-agent cap. */
const DEFAULT_CAP_PER_AGENT = 32;
/** SPEC-HITL-CC-001 R2: 24h TTL. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface BufferedReplyEntry extends BufferedReply {
  sequence: number;
}

export interface ReplyBufferOptions {
  /** Override the per-agent_id ring cap (default 32). */
  capPerAgent?: number;
  /** Override the entry TTL in ms (default 24h). */
  ttlMs?: number;
  /** Test-only: override the time source (default Date.now). */
  now?: () => number;
}

export class ReplyBuffer {
  private readonly buckets = new Map<string, BufferedReplyEntry[]>();
  private readonly cap: number;
  private readonly ttlMs: number;
  private readonly nowFn: () => number;
  private nextSequence = 0;

  constructor(opts: ReplyBufferOptions = {}) {
    this.cap = opts.capPerAgent ?? DEFAULT_CAP_PER_AGENT;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /**
   * Queue a reply for later replay. Bucketed by `payload.agent_id`. When a
   * bucket exceeds the cap, the oldest entry in that bucket is evicted FIFO.
   */
  push(payload: ReplyPayload): void {
    const key = payload.agent_id ?? "";
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    bucket.push({
      payload,
      raw: JSON.stringify(payload),
      queuedAt: this.nowFn(),
      sequence: this.nextSequence++,
    });
    while (bucket.length > this.cap) {
      bucket.shift();
    }
  }

  /**
   * Snapshot of live (non-expired) entries in arrival order. Expired entries
   * are pruned as a side effect. Buffer state is otherwise NOT modified —
   * callers MUST invoke commit(entry) for each successfully delivered entry
   * to remove it from the buffer.
   *
   * This is the contract that protects against partial-send failure: a WS
   * that drops mid-loop leaves uncommitted entries in the buffer for the
   * next reconnect.
   */
  peek(): BufferedReply[] {
    this.evictExpired();
    const all: BufferedReplyEntry[] = [];
    for (const bucket of this.buckets.values()) {
      all.push(...bucket);
    }
    all.sort((a, b) => a.sequence - b.sequence);
    return all;
  }

  /**
   * Remove a specific entry from the buffer (identified by reference equality
   * on the BufferedReply object returned from peek). Returns true if the
   * entry was found and removed; false if it was already absent (idempotent
   * against double-commit / concurrent drainers).
   */
  commit(entry: BufferedReply): boolean {
    const key = entry.payload.agent_id ?? "";
    const bucket = this.buckets.get(key);
    if (!bucket) return false;
    const idx = bucket.indexOf(entry as BufferedReplyEntry);
    if (idx === -1) return false;
    bucket.splice(idx, 1);
    if (bucket.length === 0) this.buckets.delete(key);
    return true;
  }

  /**
   * Remove a reply from the buffer by its unique ID.
   * This is invoked when the client successfully receives and acknowledges
   * a message via an "ack" control frame, implementing the application-level
   * ACK protocol to prevent message drops on reconnect.
   * Returns true if found and removed; false if already absent.
   */
  commitById(id: string): boolean {
    for (const [key, bucket] of this.buckets.entries()) {
      const idx = bucket.findIndex((e) => e.payload.id === id);
      if (idx !== -1) {
        bucket.splice(idx, 1);
        if (bucket.length === 0) {
          this.buckets.delete(key);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Convenience: peek + commit-all in one call. Returns live entries in
   * arrival order and removes them from the buffer. Expired entries are
   * dropped silently.
   *
   * Production WS delivery MUST use peek + per-entry commit so partial-send
   * failures (ws.readyState != OPEN mid-loop) don't lose data. This helper
   * is for tests, shutdown, and any path that has already confirmed receipt
   * for the entire batch.
   */
  drain(): BufferedReply[] {
    const live = this.peek();
    for (const entry of live) this.commit(entry);
    return live;
  }

  /** Total entries currently buffered across all agent_id buckets (incl. expired). */
  size(): number {
    let n = 0;
    for (const bucket of this.buckets.values()) n += bucket.length;
    return n;
  }

  /** Drop expired entries from every bucket. Pure pruning — no replay. */
  private evictExpired(): void {
    const cutoff = this.nowFn() - this.ttlMs;
    for (const [key, bucket] of this.buckets) {
      const live = bucket.filter((e) => e.queuedAt >= cutoff);
      if (live.length === 0) {
        this.buckets.delete(key);
      } else if (live.length !== bucket.length) {
        this.buckets.set(key, live);
      }
    }
  }
}

// ─── SPEC-HITL-APP-10832 Phase 1a — Disk-Persisted WorkerOutbox ───────────

export const WORKER_OUTBOX_MAX_INLINE_BYTES = 256 * 1024;
const WORKER_OUTBOX_CAP_PER_RUN = 32;

const PINNED_WORKER_EVENT_KINDS = new Set([
  "completed",
  "failed",
  "cancelled",
  "permission_request",
]);

function truncateUtf8Safe(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = Math.min(text.length, maxBytes);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    let end = mid;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      end--;
    }
    if (Buffer.byteLength(text.slice(0, end), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  let end = low;
  if (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      end--;
    }
  }
  return text.slice(0, end);
}

export function truncateWorkerInlineText(
  raw: string,
  maxBytes = WORKER_OUTBOX_MAX_INLINE_BYTES,
): { text: string; truncated: boolean; originalBytes: number } {
  const originalBytes = Buffer.byteLength(raw, "utf8");
  if (originalBytes <= maxBytes) {
    return { text: raw, truncated: false, originalBytes };
  }
  const maxSuffix = `\n\n[truncated — ${originalBytes} bytes omitted]`;
  const suffixBudget = Buffer.byteLength(maxSuffix, "utf8");
  const prefixBudget = Math.max(0, maxBytes - suffixBudget);
  const prefix = truncateUtf8Safe(raw, prefixBudget);
  const omittedBytes = Math.max(
    1,
    originalBytes - Buffer.byteLength(prefix, "utf8"),
  );
  const suffix = `\n\n[truncated — ${omittedBytes} bytes omitted]`;
  return {
    text: prefix + suffix,
    truncated: true,
    originalBytes,
  };
}

export interface BufferedWorkerEvent {
  payload: HostRunEventFrame;
  raw: string;
  queuedAt: number;
  sequence: number;
}

interface PersistedWorkerOutboxLine {
  queuedAt: number;
  sequence: number;
  frame: HostRunEventFrame;
}

export interface WorkerOutboxOptions {
  instanceId: string;
  filePath?: string;
  capPerRun?: number;
  ttlMs?: number;
  maxInlineBytes?: number;
  now?: () => number;
}

function isValidWorkerEventFrame(raw: unknown): raw is HostRunEventFrame {
  if (!raw || typeof raw !== "object") return false;
  const f = raw as Record<string, unknown>;
  return (
    f.type === "host_run_event" &&
    typeof f.event_id === "string" &&
    f.event_id.length > 0 &&
    typeof f.run_id === "string" &&
    f.run_id.length > 0 &&
    typeof f.acp_session_id === "string" &&
    typeof f.kind === "string" &&
    typeof f.ts === "string"
  );
}

export class WorkerOutbox {
  readonly filePath: string;
  private readonly buckets = new Map<string, BufferedWorkerEvent[]>();
  private readonly capPerRun: number;
  private readonly ttlMs: number;
  private readonly maxInlineBytes: number;
  private readonly nowFn: () => number;
  private nextSequence = 0;

  constructor(opts: WorkerOutboxOptions) {
    const safeId = opts.instanceId.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
    this.filePath =
      opts.filePath ?? join(getChannelHome(), `worker-outbox-${safeId}.jsonl`);
    this.capPerRun = opts.capPerRun ?? WORKER_OUTBOX_CAP_PER_RUN;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxInlineBytes = opts.maxInlineBytes ?? WORKER_OUTBOX_MAX_INLINE_BYTES;
    this.nowFn = opts.now ?? (() => Date.now());
    this.loadFromDisk();
  }

  private normalizeFrame(frame: HostRunEventFrame): HostRunEventFrame {
    let next: HostRunEventFrame = { ...frame };
    if (PINNED_WORKER_EVENT_KINDS.has(next.kind)) {
      next.pinned = true;
    } else if (next.pinned === undefined) {
      next.pinned = false;
    }

    if (typeof next.output === "string") {
      const res = truncateWorkerInlineText(next.output, this.maxInlineBytes);
      if (res.truncated) {
        next = {
          ...next,
          output: res.text,
          output_truncated: true,
          original_bytes: res.originalBytes,
        };
      }
    }

    if (typeof next.text === "string") {
      const res = truncateWorkerInlineText(next.text, this.maxInlineBytes);
      if (res.truncated) {
        next = {
          ...next,
          text: res.text,
          output_truncated: true,
          original_bytes: next.original_bytes ?? res.originalBytes,
        };
      }
    }

    return next;
  }

  private loadFromDisk(): void {
    assertTestStatePath(this.filePath);
    if (!existsSync(this.filePath)) {
      return;
    }

    let rawContent = "";
    try {
      rawContent = readFileSync(this.filePath, "utf8");
    } catch (err) {
      process.stderr.write(
        `[hitl-channel] ERROR: Failed to read worker outbox ${this.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return;
    }

    const lines = rawContent.split(/\r?\n/);
    const corruptLines: string[] = [];
    let maxSeq = -1;

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        corruptLines.push(rawLine);
        continue;
      }

      let frame: unknown;
      let queuedAt: number | undefined;
      let sequence: number | undefined;
      if (
        parsed &&
        typeof parsed === "object" &&
        "frame" in (parsed as Record<string, unknown>)
      ) {
        const rec = parsed as Partial<PersistedWorkerOutboxLine>;
        frame = rec.frame;
        if (typeof rec.queuedAt === "number" && Number.isFinite(rec.queuedAt)) {
          queuedAt = rec.queuedAt;
        }
        if (typeof rec.sequence === "number" && Number.isFinite(rec.sequence)) {
          sequence = rec.sequence;
        }
      } else {
        frame = parsed;
      }

      if (!isValidWorkerEventFrame(frame)) {
        corruptLines.push(rawLine);
        continue;
      }

      const seq = sequence ?? ++maxSeq;
      if (seq > maxSeq) maxSeq = seq;
      const entryQueuedAt =
        queuedAt ??
        (Number.isFinite(Date.parse(frame.ts)) ? Date.parse(frame.ts) : this.nowFn());
      const normalized = this.normalizeFrame(frame);
      const bucket = this.buckets.get(normalized.run_id) ?? [];
      bucket.push({
        payload: normalized,
        raw: JSON.stringify(normalized),
        queuedAt: entryQueuedAt,
        sequence: seq,
      });
      this.buckets.set(normalized.run_id, bucket);
    }

    this.nextSequence = maxSeq + 1;

    if (corruptLines.length > 0) {
      const quarantinePath = `${this.filePath}.corrupt-${this.nowFn()}.jsonl`;
      assertTestStatePath(quarantinePath);
      process.stderr.write(
        `[hitl-channel] ERROR: Quarantining ${corruptLines.length} corrupt line(s) from ${this.filePath} -> ${quarantinePath}\n`,
      );
      try {
        mkdirSync(dirname(quarantinePath), { recursive: true });
        writeFileSync(quarantinePath, corruptLines.join("\n") + "\n", "utf8");
      } catch (err) {
        process.stderr.write(
          `[hitl-channel] ERROR: Failed to write quarantine file ${quarantinePath}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
      this.persistToDisk();
    }
  }

  private persistToDisk(): void {
    assertTestStatePath(this.filePath);
    const all: BufferedWorkerEvent[] = [];
    for (const bucket of this.buckets.values()) {
      all.push(...bucket);
    }
    all.sort((a, b) => a.sequence - b.sequence);

    const lines = all
      .map((entry) =>
        JSON.stringify({
          queuedAt: entry.queuedAt,
          sequence: entry.sequence,
          frame: entry.payload,
        } satisfies PersistedWorkerOutboxLine),
      )
      .join("\n");
    const content = lines.length > 0 ? `${lines}\n` : "";

    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    assertTestStatePath(tmpPath);
    const fd = openSync(tmpPath, "w", 0o600);
    try {
      if (content.length > 0) {
        writeSync(fd, content, 0, "utf8");
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, this.filePath);
  }

  push(frame: HostRunEventFrame): HostRunEventFrame {
    const normalized = this.normalizeFrame(frame);
    let bucket = this.buckets.get(normalized.run_id);
    if (!bucket) {
      bucket = [];
      this.buckets.set(normalized.run_id, bucket);
    }

    const entry: BufferedWorkerEvent = {
      payload: normalized,
      raw: JSON.stringify(normalized),
      queuedAt: this.nowFn(),
      sequence: this.nextSequence++,
    };
    bucket.push(entry);

    if (bucket.length > this.capPerRun) {
      const existingCompacted = bucket.find(
        (e) => e.payload.kind === "outbox_compacted",
      );
      let droppedNow = 0;
      let firstDroppedSeq: number | null = null;

      const evictOldestUnpinned = (): boolean => {
        const idx = bucket!.findIndex(
          (e) => !e.payload.pinned && e.payload.kind !== "outbox_compacted",
        );
        if (idx === -1) return false;
        const [removed] = bucket!.splice(idx, 1);
        if (removed) {
          if (firstDroppedSeq === null || removed.sequence < firstDroppedSeq) {
            firstDroppedSeq = removed.sequence;
          }
          droppedNow++;
        }
        return true;
      };

      const targetBeforeCompactedNotice = existingCompacted
        ? this.capPerRun
        : this.capPerRun - 1;
      while (bucket.length > targetBeforeCompactedNotice) {
        if (!evictOldestUnpinned()) break;
      }

      if (droppedNow > 0) {
        if (existingCompacted) {
          const prevDropped = existingCompacted.payload.dropped_count ?? 0;
          existingCompacted.payload = {
            ...existingCompacted.payload,
            dropped_count: prevDropped + droppedNow,
            ts: normalized.ts,
          };
          existingCompacted.raw = JSON.stringify(existingCompacted.payload);
        } else {
          const compactedFrame: HostRunEventFrame = {
            type: "host_run_event",
            event_id: globalThis.crypto.randomUUID(),
            run_id: normalized.run_id,
            acp_session_id: normalized.acp_session_id,
            kind: "outbox_compacted",
            pinned: false,
            dropped_count: droppedNow,
            ts: normalized.ts,
          };
          bucket.unshift({
            payload: compactedFrame,
            raw: JSON.stringify(compactedFrame),
            queuedAt: this.nowFn(),
            sequence: firstDroppedSeq ?? this.nextSequence++,
          });
        }
      }
    }

    this.persistToDisk();
    return normalized;
  }

  peek(): BufferedWorkerEvent[] {
    const expired = this.evictExpired();
    if (expired) {
      this.persistToDisk();
    }
    const all: BufferedWorkerEvent[] = [];
    for (const bucket of this.buckets.values()) {
      all.push(...bucket);
    }
    all.sort((a, b) => a.sequence - b.sequence);
    return all;
  }

  commitById(eventId: string): boolean {
    for (const [runId, bucket] of this.buckets.entries()) {
      const idx = bucket.findIndex((e) => e.payload.event_id === eventId);
      if (idx !== -1) {
        bucket.splice(idx, 1);
        if (bucket.length === 0) {
          this.buckets.delete(runId);
        }
        this.persistToDisk();
        return true;
      }
    }
    return false;
  }

  unpinByChoicesId(choicesId: string): boolean {
    let changed = false;
    for (const bucket of this.buckets.values()) {
      for (const entry of bucket) {
        if (
          entry.payload.kind === "permission_request" &&
          entry.payload.choices_id === choicesId &&
          entry.payload.pinned
        ) {
          entry.payload = { ...entry.payload, pinned: false };
          entry.raw = JSON.stringify(entry.payload);
          changed = true;
        }
      }
    }
    if (changed) {
      this.persistToDisk();
    }
    return changed;
  }

  size(): number {
    let n = 0;
    for (const bucket of this.buckets.values()) {
      n += bucket.length;
    }
    return n;
  }

  clear(): void {
    this.buckets.clear();
    this.persistToDisk();
  }

  private evictExpired(): boolean {
    const cutoff = this.nowFn() - this.ttlMs;
    let changed = false;
    for (const [runId, bucket] of this.buckets.entries()) {
      const live = bucket.filter((e) => e.queuedAt >= cutoff);
      if (live.length !== bucket.length) {
        changed = true;
        if (live.length === 0) {
          this.buckets.delete(runId);
        } else {
          this.buckets.set(runId, live);
        }
      }
    }
    return changed;
  }
}
