/**
 * Per-instance in-memory ring buffer for WS replies queued while no clients
 * are connected. SPEC-HITL-CC-001 Phase 4 AC#26.
 *
 * - Keyed on `agent_id` (empty string when unset).
 * - Bucket cap = 32 (R2). FIFO eviction once a bucket exceeds the cap.
 * - Entry TTL = 24h (R2). Expired entries are dropped at drain time, never
 *   replayed.
 * - In-memory only — daemon restart clears the buffer (acceptable since
 *   hitl-channel runs alongside CC on the user's desktop; restart is rare
 *   and explicit per umbrella issue hitl-app#4043).
 * - Cross-instance isolation: each ReplyBuffer holds its own buckets, so
 *   two daemons (or two test fixtures) never share state.
 */

import type { BufferedReply, ReplyPayload } from "./types.js";

/** SPEC-HITL-CC-001 R2: per-agent cap. */
const DEFAULT_CAP_PER_AGENT = 32;
/** SPEC-HITL-CC-001 R2: 24h TTL. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ReplyBufferOptions {
  /** Override the per-agent_id ring cap (default 32). */
  capPerAgent?: number;
  /** Override the entry TTL in ms (default 24h). */
  ttlMs?: number;
  /** Test-only: override the time source (default Date.now). */
  now?: () => number;
}

export class ReplyBuffer {
  private readonly buckets = new Map<string, BufferedReply[]>();
  private readonly cap: number;
  private readonly ttlMs: number;
  private readonly nowFn: () => number;

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
    bucket.push({ payload, queuedAt: this.nowFn() });
    while (bucket.length > this.cap) {
      bucket.shift();
    }
  }

  /**
   * Drain every live (non-expired) entry across all agent_id buckets in
   * arrival order. The buffer is fully cleared on return — expired entries
   * are dropped silently and never replayed.
   */
  drain(): BufferedReply[] {
    const cutoff = this.nowFn() - this.ttlMs;
    const live: BufferedReply[] = [];
    for (const bucket of this.buckets.values()) {
      for (const entry of bucket) {
        if (entry.queuedAt >= cutoff) live.push(entry);
      }
    }
    this.buckets.clear();
    live.sort((a, b) => a.queuedAt - b.queuedAt);
    return live;
  }

  /** Total entries currently buffered across all agent_id buckets (incl. expired). */
  size(): number {
    let n = 0;
    for (const bucket of this.buckets.values()) n += bucket.length;
    return n;
  }
}
