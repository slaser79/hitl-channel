import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { spawnAcpTransport } from "../acp_client.js";
import { startDaemon } from "../daemon.js";
import { replyBuffer, startHttpBridge } from "../http_bridge.js";
import {
  WORKER_OUTBOX_MAX_INLINE_BYTES,
  WorkerOutbox,
} from "../reply_buffer.js";
import type { HostRunEventFrame } from "../types.js";

const FAKE_AGENT_PATH = join(
  import.meta.dir,
  "fixtures",
  "fake_acp_agent.ts",
);

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("Timed out waiting for predicate");
}

function makeWorkerEvent(
  overrides: Partial<HostRunEventFrame> & {
    event_id: string;
    run_id: string;
    kind: HostRunEventFrame["kind"];
  },
): HostRunEventFrame {
  return {
    type: "host_run_event",
    acp_session_id: "wsess-1",
    ts: new Date().toISOString(),
    ...overrides,
  };
}

describe("SPEC-HITL-APP-10832 Phase 1a — WorkerOutbox & Handshake Drain (AV5, AV5b)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
    replyBuffer.drain();
  });

  function makeTempHome(): string {
    const dir = mkdtempSync(join(process.env.HOME!, "hitl-wo-"));
    const prevChannelHome = process.env.HITL_CHANNEL_HOME;
    process.env.HITL_CHANNEL_HOME = join(dir, "channels");
    cleanups.push(() => {
      if (prevChannelHome !== undefined) {
        process.env.HITL_CHANNEL_HOME = prevChannelHome;
      } else {
        delete process.env.HITL_CHANNEL_HOME;
      }
      rmSync(dir, { recursive: true, force: true });
    });
    return dir;
  }

  it("AV5: persists atomically to ~/.hitl/channels/worker-outbox-<id>.jsonl, survives restart & bridge replyBuffer.drain(), and commits on host_run_ack", () => {
    makeTempHome();
    let now = 1_000_000;
    const outbox1 = new WorkerOutbox({
      instanceId: "inst-av5",
      now: () => now,
    });
    expect(outbox1.filePath.endsWith("worker-outbox-inst-av5.jsonl")).toBe(true);

    outbox1.push(
      makeWorkerEvent({
        event_id: "ev-1",
        run_id: "run-1",
        kind: "started",
      }),
    );
    now += 10;
    outbox1.push(
      makeWorkerEvent({
        event_id: "ev-2",
        run_id: "run-1",
        kind: "completed",
        output: "done!",
      }),
    );

    // No temp files left behind
    const files = readdirSync(process.env.HITL_CHANNEL_HOME!);
    expect(files.some((f) => f.includes(".tmp-"))).toBe(false);
    expect(existsSync(outbox1.filePath)).toBe(true);

    // Booting an HTTP bridge drains interactive replyBuffer, NEVER workerOutbox
    const bridge = startHttpBridge(
      { notification: async () => {} } as unknown as Server,
      { port: 0 },
    );
    cleanups.push(() => bridge.stop(true));

    // Reloading from disk after simulated restart preserves all entries in order
    const outbox2 = new WorkerOutbox({
      instanceId: "inst-av5",
      now: () => now + 1000,
    });
    const peeked = outbox2.peek();
    expect(peeked.map((e) => e.payload.event_id)).toEqual(["ev-1", "ev-2"]);
    expect(peeked[1]!.payload.pinned).toBe(true);

    // ACK first entry
    expect(outbox2.commitById("ev-1")).toBe(true);
    expect(outbox2.commitById("ev-1")).toBe(false);

    // Reload again -> only ev-2 remains
    const outbox3 = new WorkerOutbox({
      instanceId: "inst-av5",
      now: () => now + 2000,
    });
    expect(outbox3.peek().map((e) => e.payload.event_id)).toEqual(["ev-2"]);
  });

  it("AV5: quarantines corrupt trailing JSONL lines without losing prior valid entries and enforces 24h TTL", () => {
    makeTempHome();
    let now = 5_000_000;
    const outbox1 = new WorkerOutbox({
      instanceId: "inst-corrupt",
      now: () => now,
    });
    outbox1.push(
      makeWorkerEvent({
        event_id: "ev-valid-1",
        run_id: "run-c",
        kind: "agent_message",
        text: "first",
      }),
    );
    outbox1.push(
      makeWorkerEvent({
        event_id: "ev-valid-2",
        run_id: "run-c",
        kind: "completed",
        output: "final",
      }),
    );

    // Append corrupt trailing line simulating mid-write power loss
    const existing = readFileSync(outbox1.filePath, "utf8");
    writeFileSync(
      outbox1.filePath,
      existing + '{"queuedAt":123,"frame":{"type":"host_run_event"\n',
      "utf8",
    );

    const outbox2 = new WorkerOutbox({
      instanceId: "inst-corrupt",
      now: () => now + 100,
    });
    expect(outbox2.peek().map((e) => e.payload.event_id)).toEqual([
      "ev-valid-1",
      "ev-valid-2",
    ]);

    const files = readdirSync(process.env.HITL_CHANNEL_HOME!);
    expect(files.some((f) => f.includes(".corrupt-"))).toBe(true);

    // Advance past 24h TTL
    now += 25 * 60 * 60 * 1000;
    expect(outbox2.peek()).toEqual([]);
    expect(outbox2.size()).toBe(0);
  });

  it("AV5b: >32 interim events compact ONLY unpinned items, emit outbox_compacted, pin terminal & permission_request, and truncate >256KB outputs inline", () => {
    makeTempHome();
    let now = 1_000_000;
    const outbox = new WorkerOutbox({
      instanceId: "inst-av5b",
      now: () => now,
    });

    // Push 1 unresolved permission_request (pinned) + 35 interim agent_message events + 1 completed (pinned)
    outbox.push(
      makeWorkerEvent({
        event_id: "ev-perm-1",
        run_id: "run-flood",
        kind: "permission_request",
        choices_id: "ch-1",
        tool_name: "bash",
        prompt: "Run cmd",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      }),
    );
    for (let i = 1; i <= 35; i++) {
      now += 10;
      outbox.push(
        makeWorkerEvent({
          event_id: `ev-msg-${i}`,
          run_id: "run-flood",
          kind: "agent_message",
          text: `interim-${i}`,
        }),
      );
    }

    const hugeOutput = "x".repeat(WORKER_OUTBOX_MAX_INLINE_BYTES + 1234);
    outbox.push(
      makeWorkerEvent({
        event_id: "ev-done",
        run_id: "run-flood",
        kind: "completed",
        output: hugeOutput,
      }),
    );

    const peeked = outbox.peek();
    expect(peeked.length).toBe(32);

    const payloads = peeked.map((e) => e.payload);
    const compacted = payloads.find((p) => p.kind === "outbox_compacted");
    expect(compacted).toBeDefined();
    expect(compacted!.dropped_count).toBeGreaterThan(0);

    const survivingInterim = payloads.filter((p) => p.kind === "agent_message");
    expect(compacted!.dropped_count! + survivingInterim.length).toBe(35);

    // Both pinned permission_request and completed are preserved!
    const perm = payloads.find((p) => p.event_id === "ev-perm-1");
    expect(perm?.pinned).toBe(true);
    const done = payloads.find((p) => p.event_id === "ev-done");
    expect(done?.pinned).toBe(true);
    expect(done?.output_truncated).toBe(true);
    expect(done?.original_bytes).toBe(Buffer.byteLength(hugeOutput, "utf8"));
    expect(Buffer.byteLength(done!.output!, "utf8")).toBeLessThanOrEqual(
      WORKER_OUTBOX_MAX_INLINE_BYTES,
    );
    expect(done!.output).toContain("[truncated — ");
    expect(done!.output).toContain("bytes omitted]");
  });

  it("AV5: over real WS, raw open and legacy client_hello NEVER drain workerOutbox; only client_hello with peer_orchestration drains and settles via host_run_ack", async () => {
    const dir = makeTempHome();
    process.env.HITL_CHANNEL_API_KEY = "av5-ws-key";

    const daemon = await startDaemon({
      harness: "agy",
      port: 0,
      cwd: dir,
      enableMdns: false,
      enableDesktopNotifications: false,
      transportFactory: (_c, _a, opts) =>
        spawnAcpTransport(process.execPath, ["run", FAKE_AGENT_PATH], {
          cwd: opts?.cwd,
        }),
    });
    cleanups.push(() => daemon.shutdown());

    // Pre-seed workerOutbox directly (simulating persisted events across disconnect)
    daemon.manager.getWorkerOutbox().push(
      makeWorkerEvent({
        event_id: "ev-replay-1",
        run_id: "run-r1",
        kind: "completed",
        output: "persisted result",
      }),
    );
    expect(daemon.manager.getWorkerOutbox().size()).toBe(1);

    // 1. Legacy WS (raw open + client_hello without peer_orchestration) gets zero host_run_event frames
    const legacyFrames: Array<Record<string, unknown>> = [];
    const legacyWs = new WebSocket(
      `ws://127.0.0.1:${daemon.port}/ws?api_key=av5-ws-key`,
    );
    cleanups.push(() => legacyWs.close());
    await new Promise<void>((resolve, reject) => {
      legacyWs.onopen = () => resolve();
      legacyWs.onerror = (e) => reject(e);
    });
    legacyWs.onmessage = (ev) => {
      legacyFrames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    };
    legacyWs.send(
      JSON.stringify({
        type: "client_hello",
        proto: 4,
        features: ["sessions", "streaming", "choices_settled"],
      }),
    );
    await waitFor(() => legacyFrames.some((f) => f.type === "session_list"));
    await new Promise((r) => setTimeout(r, 40));
    expect(legacyFrames.some((f) => f.type === "host_run_event")).toBe(false);
    expect(daemon.manager.getWorkerOutbox().size()).toBe(1);

    // 2. Peer-capable WS receives host_run_event ONLY after client_hello with peer_orchestration
    const peerFrames: Array<Record<string, unknown>> = [];
    const peerWs = new WebSocket(
      `ws://127.0.0.1:${daemon.port}/ws?api_key=av5-ws-key`,
    );
    cleanups.push(() => peerWs.close());
    await new Promise<void>((resolve, reject) => {
      peerWs.onopen = () => resolve();
      peerWs.onerror = (e) => reject(e);
    });
    peerWs.onmessage = (ev) => {
      peerFrames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    };

    // Wait briefly after raw open — must NOT drain before client_hello!
    await new Promise((r) => setTimeout(r, 40));
    expect(peerFrames.some((f) => f.type === "host_run_event")).toBe(false);

    peerWs.send(
      JSON.stringify({
        type: "client_hello",
        proto: 4,
        features: ["sessions", "streaming", "peer_orchestration"],
      }),
    );
    await waitFor(() =>
      peerFrames.some(
        (f) => f.type === "host_run_event" && f.event_id === "ev-replay-1",
      ),
    );
    expect(daemon.manager.getWorkerOutbox().size()).toBe(1);

    // Acknowledge via host_run_ack -> settled from outbox
    peerWs.send(
      JSON.stringify({
        type: "host_run_ack",
        event_id: "ev-replay-1",
        run_id: "run-r1",
      }),
    );
    await waitFor(() => daemon.manager.getWorkerOutbox().size() === 0);
  });
});
