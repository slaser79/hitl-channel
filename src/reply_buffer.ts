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

import type { BufferedReply, ReplyPayload } from "./types.js";

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
