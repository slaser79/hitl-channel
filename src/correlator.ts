/**
 * Request-ID correlator for round-trip WS frames (tool_call_*, list_tools_*).
 *
 * SPEC-HITL-CC-001 §4.2: `pending: Map<requestId, {resolve, reject, timer}>`.
 * `register(reqId, timeoutMs)` returns a Promise; `resolve(reqId, payload)` and
 * `reject(reqId, err)` fire from the WS message handler.
 *
 * Idempotency note: a result for an unknown or already-resolved request_id is
 * dropped (the caller is responsible for logging — see server.ts).
 */
export class FrameCorrelator {
  private readonly pending = new Map<
    string,
    {
      resolve: (payload: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * Register a pending request. Returns a Promise that resolves when
   * `resolve(reqId, payload)` is called or rejects on timeout / `reject`.
   *
   * Throws synchronously if `reqId` is already registered — callers must
   * generate fresh UUIDs per request.
   */
  register<T = unknown>(reqId: string, timeoutMs: number): Promise<T> {
    if (this.pending.has(reqId)) {
      throw new Error(`correlator: duplicate request_id ${reqId}`);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`timeout after ${timeoutMs}ms (request_id=${reqId})`));
      }, timeoutMs);
      this.pending.set(reqId, {
        resolve: (payload) => resolve(payload as T),
        reject,
        timer,
      });
    });
  }

  /**
   * Resolve a pending request. Returns `true` if a waiter was resolved,
   * `false` if the reqId was unknown or already settled.
   */
  resolve(reqId: string, payload: unknown): boolean {
    const entry = this.pending.get(reqId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(reqId);
    entry.resolve(payload);
    return true;
  }

  /**
   * Reject a pending request explicitly (e.g. on connection drop).
   */
  reject(reqId: string, err: Error): boolean {
    const entry = this.pending.get(reqId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(reqId);
    entry.reject(err);
    return true;
  }

  /** Test helper: current number of outstanding requests. */
  get size(): number {
    return this.pending.size;
  }

  /** Reject every outstanding request — used on shutdown / disconnect. */
  rejectAll(err: Error): void {
    for (const [reqId] of this.pending) {
      this.reject(reqId, err);
    }
  }
}
