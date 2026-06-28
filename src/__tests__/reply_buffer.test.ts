/**
 * SPEC-HITL-CC-001 Phase 4 AC#26 — five named acceptance tests for the
 * per-instance ReplyBuffer. See hitl-channel#10 for the AC wording.
 */

import { describe, expect, it } from "bun:test";
import { ReplyBuffer } from "../reply_buffer.js";
import { drainBufferToClient, drainBufferToClientSync } from "../http_bridge.js";
import type {
  BufferDrainAuditLine,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- imported for shape sanity
} from "../audit.js";
import type { HitlWebSocket, ReplyPayload } from "../types.js";

function makeReply(
  text: string,
  messageId: string,
  agentId?: string,
  idSuffix = "x",
): ReplyPayload {
  return {
    type: "reply",
    text,
    content: text,
    id: `r-${idSuffix}`,
    message_id: messageId,
    agent_id: agentId,
    ts: new Date().toISOString(),
  };
}

function makeFakeWs(): { ws: HitlWebSocket; sent: string[] } {
  const sent: string[] = [];
  const ws: HitlWebSocket = {
    readyState: 1,
    send: (data: string) => {
      sent.push(data);
      return data.length;
    },
  };
  return { ws, sent };
}

describe("ReplyBuffer — SPEC-HITL-CC-001 AC#26", () => {
  // ─── Test 1 ───────────────────────────────────────────────────────────
  it("Test 1: disconnect → 2 replies → reconnect drains in arrival order", () => {
    let t = 1_000_000;
    const buf = new ReplyBuffer({ now: () => t });
    // Simulate WS-disconnect window: broadcastReply falls through to push().
    buf.push(makeReply("first", "m1", "agentA", "1"));
    t += 50;
    buf.push(makeReply("second", "m2", "agentA", "2"));
    expect(buf.size()).toBe(2);

    // Simulate WS reconnect: the open handler calls drain().
    const drained = buf.drain();
    expect(drained.length).toBe(2);
    expect(drained.map((e) => e.payload.message_id)).toEqual(["m1", "m2"]);
    expect(drained.map((e) => e.payload.content)).toEqual(["first", "second"]);
    // Arrival-order check via received_at timestamps (queuedAt):
    expect(drained[0].queuedAt).toBeLessThanOrEqual(drained[1].queuedAt);
    // Buffer must clear after drain.
    expect(buf.size()).toBe(0);
  });

  // ─── Test 2 ───────────────────────────────────────────────────────────
  it("Test 2: FIFO across cap edge — 35 pushed → drain returns last 32", () => {
    const buf = new ReplyBuffer({ capPerAgent: 32 });
    for (let i = 1; i <= 35; i++) {
      buf.push(makeReply(`r${i}`, `m${i}`, "agentA", String(i)));
    }
    const drained = buf.drain();
    expect(drained.length).toBe(32);
    // Oldest 3 (m1, m2, m3) must have been evicted FIFO.
    expect(drained[0].payload.message_id).toBe("m4");
    expect(drained[drained.length - 1].payload.message_id).toBe("m35");
  });

  // ─── Test 3 ───────────────────────────────────────────────────────────
  it("Test 3: TTL — fake clock past 24h drops expired entries before drain", () => {
    let t = 1_000_000;
    const buf = new ReplyBuffer({ ttlMs: 24 * 60 * 60 * 1000, now: () => t });
    buf.push(makeReply("hello", "m1", "agentA", "1"));
    buf.push(makeReply("world", "m2", "agentA", "2"));
    expect(buf.size()).toBe(2);
    // Advance fake clock past 24h.
    t += 25 * 60 * 60 * 1000;
    const drained = buf.drain();
    expect(drained.length).toBe(0);
    expect(buf.size()).toBe(0);
  });

  // ─── Test 4 ───────────────────────────────────────────────────────────
  it("Test 4: cross-instance isolation — buffer A does not drain to buffer B", () => {
    const instanceA = new ReplyBuffer();
    const instanceB = new ReplyBuffer();
    instanceA.push(makeReply("from A", "mA", "agentA", "A"));
    instanceB.push(makeReply("from B", "mB", "agentB", "B"));

    const drainedA = instanceA.drain();
    expect(drainedA.length).toBe(1);
    expect(drainedA[0].payload.message_id).toBe("mA");
    expect(drainedA[0].payload.agent_id).toBe("agentA");

    const drainedB = instanceB.drain();
    expect(drainedB.length).toBe(1);
    expect(drainedB[0].payload.message_id).toBe("mB");
    expect(drainedB[0].payload.agent_id).toBe("agentB");
  });

  // ─── Test 5 ───────────────────────────────────────────────────────────
  it("Test 5: emits phone_offline_buffer_drain audit line with replies_drained + oldest_buffered_seconds", async () => {
    let t = 1_000_000;
    const buf = new ReplyBuffer({ now: () => t });
    buf.push(makeReply("a", "m1", "agentA", "1"));
    t += 100;
    buf.push(makeReply("b", "m2", "agentA", "2"));
    t += 100;
    buf.push(makeReply("c", "m3", "agentA", "3"));

    // Advance the "wall clock" feeding drainBufferToClient so the oldest
    // entry registers as 7 seconds old at drain time.
    const drainWallClockMs = t + 7_000;

    const { ws, sent } = makeFakeWs();
    const auditCalls: BufferDrainAuditLine[] = [];
    const fakeAudit = async (line: BufferDrainAuditLine) => {
      auditCalls.push(line);
    };

    const n = await drainBufferToClient(ws, buf, fakeAudit, () => drainWallClockMs);
    expect(n).toBe(3);
    expect(sent.length).toBe(3);

    expect(auditCalls.length).toBe(1);
    const line = auditCalls[0]!;
    expect(line.event).toBe("phone_offline_buffer_drain");
    expect(line.replies_drained).toBe(3);
    expect(line.oldest_buffered_seconds).toBe(7);
    expect(typeof line.instance_id).toBe("string");
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ─── Guard: empty drain does NOT emit an audit line ───────────────────
  it("guard: empty buffer does not emit a phone_offline_buffer_drain audit line", async () => {
    const buf = new ReplyBuffer();
    const { ws } = makeFakeWs();
    const auditCalls: BufferDrainAuditLine[] = [];
    const fakeAudit = async (line: BufferDrainAuditLine) => {
      auditCalls.push(line);
    };
    const n = await drainBufferToClient(ws, buf, fakeAudit);
    expect(n).toBe(0);
    expect(auditCalls.length).toBe(0);
  });

  // ─── P0 regression: peek + per-entry commit ───────────────────────────
  // The buffer used to call `drain()` (destructive clear) BEFORE confirming
  // ws.send succeeded. If the WS dropped mid-loop, remaining entries were
  // permanently lost. peek + commit now leaves un-sent entries in the buffer.
  // ─── P0 regression: peek + per-entry commit ───────────────────────────
  // Under the new ACK-based protocol, entries are NOT committed/deleted during
  // drainBufferToClientSync. They stay in the buffer until an explicit ACK
  // control frame is received.
  it("P0 regression: partial-send (ws dies mid-loop) leaves remaining entries in buffer until ACKed", () => {
    const buf = new ReplyBuffer();
    buf.push(makeReply("a", "m1", "agentA", "1"));
    buf.push(makeReply("b", "m2", "agentA", "2"));
    buf.push(makeReply("c", "m3", "agentA", "3"));
    expect(buf.size()).toBe(3);

    // Fake WS that closes after the first send.
    const sent: string[] = [];
    let sendCount = 0;
    const ws: HitlWebSocket = {
      readyState: 1,
      send: (data: string) => {
        sent.push(data);
        sendCount++;
        if (sendCount >= 1) ws.readyState = 3; // CLOSED after first send
      },
    };

    const { sent: sentCount } = drainBufferToClientSync(ws, buf);
    expect(sentCount).toBe(1);          // only the first entry was sent
    expect(sent.length).toBe(1);
    expect(buf.size()).toBe(3);         // Still 3 because no ACKs have been received!

    // Client ACKs the first message (id: 'r-1')
    const firstPayload = JSON.parse(sent[0]) as ReplyPayload;
    expect(buf.commitById(firstPayload.id)).toBe(true);
    expect(buf.size()).toBe(2);         // Now 2

    // Second reconnect: a healthy WS drains the rest.
    const { ws: ws2, sent: sent2 } = makeFakeWs();
    const r2 = drainBufferToClientSync(ws2, buf);
    expect(r2.sent).toBe(2);
    expect(sent2.length).toBe(2);
    const ids = sent2.map((s) => JSON.parse(s).message_id);
    expect(ids).toEqual(["m2", "m3"]);
    expect(buf.size()).toBe(2);         // Still 2 because they are not ACKed yet!

    // Client ACKs the remaining two messages
    for (const s of sent2) {
      const payload = JSON.parse(s) as ReplyPayload;
      expect(buf.commitById(payload.id)).toBe(true);
    }
    expect(buf.size()).toBe(0);
  });

  // ─── P2 regression: audit `replies_drained` reflects actual sends ─────
  it("P2 regression: audit replies_drained counts actual ws.send successes, not peek snapshot length", async () => {
    const buf = new ReplyBuffer();
    buf.push(makeReply("a", "m1", "agentA", "1"));
    buf.push(makeReply("b", "m2", "agentA", "2"));
    buf.push(makeReply("c", "m3", "agentA", "3"));

    // Fake WS that dies after 2 sends.
    const sent: string[] = [];
    let sendCount = 0;
    const ws: HitlWebSocket = {
      readyState: 1,
      send: (data: string) => {
        sent.push(data);
        sendCount++;
        if (sendCount >= 2) ws.readyState = 3;
      },
    };

    const auditCalls: BufferDrainAuditLine[] = [];
    const fakeAudit = async (line: BufferDrainAuditLine) => {
      auditCalls.push(line);
    };

    const n = await drainBufferToClient(ws, buf, fakeAudit, () => Date.now());
    expect(n).toBe(2);                       // 2 actually sent
    expect(auditCalls.length).toBe(1);
    expect(auditCalls[0]!.replies_drained).toBe(2); // not 3 (the peek snapshot length)
    expect(buf.size()).toBe(3);              // m3 and others still buffered
  });

  // ─── P1#2 regression: concurrent drains are safe ──────────────────────
  // Since drain no longer commits, a reconnect redelivers until ACKed.
  it("P1#2 regression: a second sync drain on the same buffer redelivers until ACKed", () => {
    const buf = new ReplyBuffer();
    buf.push(makeReply("a", "m1", "agentA", "1"));
    buf.push(makeReply("b", "m2", "agentA", "2"));

    const { ws: ws1, sent: sent1 } = makeFakeWs();
    const r1 = drainBufferToClientSync(ws1, buf);
    expect(r1.sent).toBe(2);
    expect(sent1.length).toBe(2);

    // If we drain again without ACKing, it should redeliver
    const { ws: ws2, sent: sent2 } = makeFakeWs();
    const r2 = drainBufferToClientSync(ws2, buf);
    expect(r2.sent).toBe(2);
    expect(sent2.length).toBe(2);

    // Now ACK the messages
    for (const s of sent1) {
      const payload = JSON.parse(s) as ReplyPayload;
      expect(buf.commitById(payload.id)).toBe(true);
    }

    // A third drain should return zero because they are now committed/ACKed
    const { ws: ws3, sent: sent3 } = makeFakeWs();
    const r3 = drainBufferToClientSync(ws3, buf);
    expect(r3.sent).toBe(0);
    expect(sent3.length).toBe(0);
  });

  // ─── P1 regression: ws.send return value gates commit ─────────────────
  it("P1 regression: failed ws.send result leaves current and remaining entries buffered", () => {
    const buf = new ReplyBuffer();
    buf.push(makeReply("a", "m1", "agentA", "1"));
    buf.push(makeReply("b", "m2", "agentA", "2"));
    buf.push(makeReply("c", "m3", "agentA", "3"));

    const accepted: string[] = [];
    let attempts = 0;
    const ws: HitlWebSocket = {
      readyState: 1,
      send: (data: string) => {
        attempts++;
        if (attempts === 1) {
          accepted.push(data);
          return data.length;
        }
        return 0;
      },
    };

    const r1 = drainBufferToClientSync(ws, buf);
    expect(r1.sent).toBe(1);
    expect(accepted.length).toBe(1);
    expect(buf.size()).toBe(3); // Still 3

    // ACK the first one
    const firstPayload = JSON.parse(accepted[0]) as ReplyPayload;
    expect(buf.commitById(firstPayload.id)).toBe(true);
    expect(buf.size()).toBe(2);

    // Second reconnect drains the remaining 2
    const { ws: ws2, sent: sent2 } = makeFakeWs();
    const r2 = drainBufferToClientSync(ws2, buf);
    expect(r2.sent).toBe(2);
    expect(sent2.map((s) => JSON.parse(s).message_id)).toEqual(["m2", "m3"]);
    expect(buf.size()).toBe(2); // Still 2 until ACKed

    // ACK the rest
    for (const s of sent2) {
      const payload = JSON.parse(s) as ReplyPayload;
      expect(buf.commitById(payload.id)).toBe(true);
    }
    expect(buf.size()).toBe(0);
  });

  // ─── P1 regression: arrival order is monotonic, not wall-clock sorted ─
  it("P1 regression: clock rollback does not reorder buffered replies", () => {
    const times = [1_000, 900, 1_100, 1_200];
    const buf = new ReplyBuffer({ now: () => times.shift()! });

    buf.push(makeReply("first", "m1", "agentA", "1"));
    buf.push(makeReply("second", "m2", "agentA", "2"));
    buf.push(makeReply("third", "m3", "agentA", "3"));

    const drained = buf.drain();
    expect(drained.map((e) => e.queuedAt)).toEqual([1_000, 900, 1_100]);
    expect(drained.map((e) => e.payload.message_id)).toEqual(["m1", "m2", "m3"]);
  });

  // ─── peek/commit contract ─────────────────────────────────────────────
  it("peek does not remove entries; commit removes a specific entry by reference", () => {
    const buf = new ReplyBuffer();
    buf.push(makeReply("a", "m1", "agentA", "1"));
    buf.push(makeReply("b", "m2", "agentA", "2"));

    const snap1 = buf.peek();
    expect(snap1.length).toBe(2);
    expect(buf.size()).toBe(2);             // peek did NOT remove

    const snap2 = buf.peek();
    expect(snap2.length).toBe(2);           // peek is idempotent

    expect(buf.commit(snap1[0]!)).toBe(true);
    expect(buf.size()).toBe(1);
    expect(buf.commit(snap1[0]!)).toBe(false); // double-commit is safe (idempotent)
    expect(buf.commit(snap1[1]!)).toBe(true);
    expect(buf.size()).toBe(0);
  });

  // ─── R2 P1#1 coverage: ws.send returning -1 (closed) ──────────────────
  // Different failure mode from the backpressure-drop (return 0) case above:
  // Bun returns -1 when the socket has already been closed at the OS level.
  // wsSendAccepted treats both as not-accepted, so the loop bails on the
  // first attempt and nothing gets committed.
  it("R2 P1#1: ws.send returning -1 (closed) bails without committing", () => {
    const buf = new ReplyBuffer();
    buf.push(makeReply("a", "m1", "agentA", "1"));
    buf.push(makeReply("b", "m2", "agentA", "2"));

    const ws: HitlWebSocket = {
      readyState: 1,
      send: (_data: string): number => -1,
    };

    const { sent: sentCount } = drainBufferToClientSync(ws, buf);
    expect(sentCount).toBe(0);
    expect(buf.size()).toBe(2);             // nothing sent, nothing committed
  });

  // ─── R3 P2#2 regression: pre-stringified raw is cached at push time ───
  it("R3 P2#2: BufferedReply.raw is cached at push time and matches JSON.stringify(payload)", () => {
    const buf = new ReplyBuffer();
    const payload = makeReply("hello", "m1", "agentA", "1");
    buf.push(payload);
    const [entry] = buf.peek();
    expect(entry!.raw).toBe(JSON.stringify(payload));
  });

  // ─── R3 P3#1 regression: Math.min for oldest_buffered_seconds ─────────
  // Sequence-sort puts the earliest-pushed entry first, but under clock
  // rollback that entry's queuedAt is NOT the minimum. The audit's
  // oldest_buffered_seconds must reflect the TRUE minimum wall-clock value.
  it("R3 P3#1: oldest_buffered_seconds reflects min(queuedAt) under clock rollback", async () => {
    // Push 3 entries with clock going forward, then backward, then forward.
    const times = [1_000, 2_000, 500, 1_500];
    const buf = new ReplyBuffer({ now: () => times.shift()! });
    buf.push(makeReply("a", "m1", "agentA", "1"));   // queuedAt=1000, seq=0
    buf.push(makeReply("b", "m2", "agentA", "2"));   // queuedAt=2000, seq=1
    buf.push(makeReply("c", "m3", "agentA", "3"));   // queuedAt= 500, seq=2 ← oldest by wall-clock

    const { ws } = makeFakeWs();
    const auditCalls: BufferDrainAuditLine[] = [];
    const fakeAudit = async (line: BufferDrainAuditLine) => {
      auditCalls.push(line);
    };

    // Wall-clock at drain time = 7000ms. Oldest queuedAt = 500. Age = 6.5s → 6s floor.
    await drainBufferToClient(ws, buf, fakeAudit, () => 7_000);
    expect(auditCalls.length).toBe(1);
    expect(auditCalls[0]!.oldest_buffered_seconds).toBe(6);
  });

  // ─── R2 P1#1 sibling: broadcastReply also gates on send return ────────
  // wsSendAccepted is applied at the broadcastReply call site too, so a
  // backpressure-drop on the only OPEN client doesn't suppress the buffer
  // push and lose the reply.
  it("R2 P1#1 sibling: broadcastReply pushes to buffer when the only OPEN client backpressure-drops", async () => {
    const { broadcastReply, clients, replyBuffer } = await import("../http_bridge.js");
    replyBuffer.drain();   // reset state for test isolation

    const dropping: HitlWebSocket = {
      readyState: 1,
      send: (_data: string): number => 0,   // backpressure-drop on every send
    };
    clients.add(dropping);
    try {
      broadcastReply("hello", "m-bp", "agentBP");
      const buffered = replyBuffer.drain();
      expect(buffered.length).toBe(1);
      expect(buffered[0]!.payload.message_id).toBe("m-bp");
    } finally {
      clients.delete(dropping);
    }
  });

  // ─── Issue #30 regression: broadcastReply queues when no clients ───────
  it("Issue #30: broadcastReply pushes to buffer when no clients are connected", async () => {
    const { broadcastReply, clients, replyBuffer } = await import("../http_bridge.js");
    replyBuffer.drain();
    expect(clients.size).toBe(0);
    
    broadcastReply("no clients", "m-no", "agent-no");
    const buffered = replyBuffer.drain();
    expect(buffered.length).toBe(1);
    expect(buffered[0]!.payload.text).toBe("no clients");
    expect(buffered[0]!.payload.message_id).toBe("m-no");
  });

  // ─── Issue #30 regression: broadcastReply queues when clients not OPEN ─
  it("Issue #30: broadcastReply pushes to buffer when clients are in CONNECTING state", async () => {
    const { broadcastReply, clients, replyBuffer } = await import("../http_bridge.js");
    replyBuffer.drain();
    
    const connecting: HitlWebSocket = {
      readyState: 0, // CONNECTING
      send: (_data: string) => 10,
    };
    clients.add(connecting);
    try {
      broadcastReply("connecting client", "m-conn", "agent-conn");
      const buffered = replyBuffer.drain();
      expect(buffered.length).toBe(1);
      expect(buffered[0]!.payload.text).toBe("connecting client");
    } finally {
      clients.delete(connecting);
    }
  });
});

