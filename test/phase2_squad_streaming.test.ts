import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AcpTransport } from "../src/acp_client.js";
import { AcpSessionManager } from "../src/acp_session_manager.js";
import { DAEMON_INSTRUCTIONS } from "../src/mcp_instructions.js";
import type {
  HitlWebSocket,
  HostRunEventFrame,
  StreamDeltaFrame,
  ToolProgressFrame,
} from "../src/types.js";

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for predicate");
}

class MockAcpTransport implements AcpTransport {
  readonly pid = Math.floor(Math.random() * 50000) + 10000;
  sent: Array<Record<string, unknown>> = [];
  private lineCbs: Array<(line: string) => void> = [];
  private closeCbs: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  closed = false;

  constructor(
    private readonly onOutbound: (
      msg: Record<string, unknown>,
      peer: MockAcpTransport,
    ) => void,
  ) {}

  send(line: string): void {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    this.sent.push(parsed);
    queueMicrotask(() => this.onOutbound(parsed, this));
  }

  onLine(cb: (line: string) => void): void {
    this.lineCbs.push(cb);
  }

  onClose(
    cb: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void {
    this.closeCbs.push(cb);
  }

  emit(obj: Record<string, unknown>): void {
    const raw = JSON.stringify(obj);
    for (const cb of this.lineCbs) cb(raw);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb(0, null);
  }
}

describe("SPEC-HITL-APP-10832 Phase 2a — Squad Mode opt-in worker streaming & external_session_key cleanup", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(process.env.HOME!, "hitl-p2a-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  function makeWs(): HitlWebSocket & { frames: Array<Record<string, unknown>> } {
    const frames: Array<Record<string, unknown>> = [];
    return {
      readyState: 1,
      data: { features: new Set(["sessions", "streaming", "peer_orchestration"]) },
      send: (raw: string) => {
        frames.push(JSON.parse(raw) as Record<string, unknown>);
        return raw.length;
      },
      frames,
    };
  }

  it("opt-in stream_deltas=true emits stream_delta (timer + trailing flush) and tool_progress with runId & sessionId; default omits all streaming frames", async () => {
    const dir = makeTempDir();
    let sessSeq = 0;
    const emittedFrames: Array<{ feature: string; frame: Record<string, unknown> }> = [];
    const promptSteps = new Map<
      string,
      {
        emitChunk: (text: string) => void;
        emitTool: (update: Record<string, unknown>) => void;
        finish: (stopReason?: string) => void;
      }
    >();

    const manager = new AcpSessionManager({
      harness: "codex",
      defaultCwd: dir,
      mcpUrl: "http://127.0.0.1:41201/mcp",
      mcpToken: "tok",
      instanceId: "inst-p2a-stream",
      streamCoalesceMs: 30,
      workerOutboxPath: join(dir, "outbox.jsonl"),
      transportFactory: () =>
        new MockAcpTransport((msg, p) => {
          if (msg.method === "initialize") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: { sessionCapabilities: { close: {} } },
              },
            });
          } else if (msg.method === "session/new") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessionId: `sq-sess-${++sessSeq}` },
            });
          } else if (msg.method === "session/prompt") {
            const params = msg.params as {
              sessionId: string;
              prompt: Array<{ text?: string }>;
            };
            const text = params.prompt.map((b) => b.text ?? "").join("");
            if (text.includes("__MANUAL_STREAM__")) {
              promptSteps.set(params.sessionId, {
                emitChunk: (chunk: string) => {
                  p.emit({
                    jsonrpc: "2.0",
                    method: "session/update",
                    params: {
                      sessionId: params.sessionId,
                      update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: chunk },
                      },
                    },
                  });
                },
                emitTool: (update: Record<string, unknown>) => {
                  p.emit({
                    jsonrpc: "2.0",
                    method: "session/update",
                    params: {
                      sessionId: params.sessionId,
                      update,
                    },
                  });
                },
                finish: (stopReason = "end_turn") => {
                  p.emit({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: { stopReason },
                  });
                },
              });
              return;
            }
            // Default non-streaming run also emits tool + text chunks
            p.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: "tc-quiet-1",
                  name: "read_file",
                  title: "Read file",
                  status: "in_progress",
                },
              },
            });
            p.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "quiet-output" },
                },
              },
            });
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { stopReason: "end_turn" },
            });
          }
        }),
      broadcastToCapableFn: (feature, frame) => {
        emittedFrames.push({ feature, frame });
        return 1;
      },
    });
    cleanups.push(() => manager.shutdown());

    const ws = makeWs();
    const handlers = manager.getInboundHandlers();

    // 1. Default (stream_deltas omitted) -> Phase 1 zero-broadcast behavior
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "run-quiet",
      prompt: "quiet run",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await waitFor(() =>
      emittedFrames.some(
        (e) =>
          e.frame.type === "host_run_event" &&
          e.frame.run_id === "run-quiet" &&
          e.frame.kind === "completed",
      ),
    );
    expect(
      emittedFrames.filter(
        (e) => e.frame.type === "stream_delta" || e.frame.type === "tool_progress",
      ),
    ).toHaveLength(0);
    const quietCompleted = emittedFrames.find(
      (e) => e.frame.type === "host_run_event" && e.frame.run_id === "run-quiet" && e.frame.kind === "completed",
    )!.frame as unknown as HostRunEventFrame;
    expect(quietCompleted.output).toBe("quiet-output");

    // 2. Opt-in stream_deltas: true -> streams tool_progress, timer-coalesced stream_delta, and trailing stream_delta BEFORE completed
    emittedFrames.length = 0;
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "run-stream-1",
      prompt: "__MANUAL_STREAM__",
      dispatch_depth: 1,
      message_hop: 0,
      stream_deltas: true,
    });
    await waitFor(() => promptSteps.has("sq-sess-2"));
    const ctrl = promptSteps.get("sq-sess-2")!;

    // Emit tool call + update
    ctrl.emitTool({
      sessionUpdate: "tool_call",
      toolCallId: "tc-stream-1",
      name: "bash",
      title: "Run tests",
      kind: "execute",
      status: "in_progress",
    });
    ctrl.emitTool({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-stream-1",
      status: "completed",
    });

    // Emit first chunk and let coalesce timer (30ms) flush it mid-turn
    ctrl.emitChunk("Hello ");
    await waitFor(() =>
      emittedFrames.some(
        (e) => e.frame.type === "stream_delta" && e.frame.runId === "run-stream-1",
      ),
    );

    // Emit trailing partial chunk and settle immediately (<30ms) to verify flushPendingTurnDelta before completed
    ctrl.emitChunk("squad!");
    ctrl.finish("end_turn");

    await waitFor(() =>
      emittedFrames.some(
        (e) =>
          e.frame.type === "host_run_event" &&
          e.frame.run_id === "run-stream-1" &&
          e.frame.kind === "completed",
      ),
    );

    const streamDeltas = emittedFrames
      .filter((e) => e.frame.type === "stream_delta")
      .map((e) => e.frame as unknown as StreamDeltaFrame);
    expect(streamDeltas.length).toBeGreaterThanOrEqual(2);
    expect(streamDeltas.map((d) => d.delta).join("")).toBe("Hello squad!");
    for (const d of streamDeltas) {
      expect(d.runId).toBe("run-stream-1");
      expect(d.sessionId).toBe("sq-sess-2");
    }
    expect(streamDeltas.map((d) => d.seq)).toEqual(
      streamDeltas.map((_, idx) => idx + 1),
    );

    const toolFrames = emittedFrames
      .filter((e) => e.frame.type === "tool_progress")
      .map((e) => e.frame as unknown as ToolProgressFrame);
    expect(toolFrames).toHaveLength(2);
    expect(toolFrames[0]!.runId).toBe("run-stream-1");
    expect(toolFrames[0]!.sessionId).toBe("sq-sess-2");
    expect(toolFrames[0]!.status).toBe("in_progress");
    expect(toolFrames[1]!.status).toBe("completed");
    expect(toolFrames[1]!.runId).toBe("run-stream-1");

    // Trailing delta must arrive BEFORE completed host_run_event
    const lastDeltaIdx = emittedFrames.findLastIndex(
      (e) => e.frame.type === "stream_delta" && e.frame.runId === "run-stream-1",
    );
    const completedIdx = emittedFrames.findIndex(
      (e) =>
        e.frame.type === "host_run_event" &&
        e.frame.run_id === "run-stream-1" &&
        e.frame.kind === "completed",
    );
    expect(lastDeltaIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThan(lastDeltaIdx);

    const completedEv = emittedFrames[completedIdx]!.frame as unknown as HostRunEventFrame;
    expect(completedEv.output).toBe("Hello squad!");
  });

  it("persistent external_session_key reuses one ACP session across Turn 1 and Turn 2 and injects DAEMON_INSTRUCTIONS only on Turn 1", async () => {
    const dir = makeTempDir();
    let sessionNewCalls = 0;
    const promptsReceived: Array<{ sessionId: string; text: string }> = [];
    const frames: Array<Record<string, unknown>> = [];

    const manager = new AcpSessionManager({
      harness: "hermes", // first_prompt_prefix strategy
      defaultCwd: dir,
      mcpUrl: "http://127.0.0.1:41202/mcp",
      mcpToken: "tok",
      instanceId: "inst-p2a-reuse",
      workerOutboxPath: join(dir, "outbox.jsonl"),
      transportFactory: () =>
        new MockAcpTransport((msg, p) => {
          if (msg.method === "initialize") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: { sessionCapabilities: { close: {} } },
              },
            });
          } else if (msg.method === "session/new") {
            sessionNewCalls++;
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessionId: `persist-sess-${sessionNewCalls}` },
            });
          } else if (msg.method === "session/prompt") {
            const params = msg.params as {
              sessionId: string;
              prompt: Array<{ text?: string }>;
            };
            const joined = params.prompt.map((b) => b.text ?? "").join("\n");
            promptsReceived.push({ sessionId: params.sessionId, text: joined });
            p.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: `ack:${promptsReceived.length}` },
                },
              },
            });
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { stopReason: "end_turn" },
            });
          }
        }),
      broadcastToCapableFn: (_f, frame) => {
        frames.push(frame);
        return 1;
      },
    });
    cleanups.push(() => manager.shutdown());

    const ws = makeWs();
    const handlers = manager.getInboundHandlers();

    // Turn 1 with external_session_key
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      event_id: "ev-t1",
      run_id: "turn1-run",
      external_session_key: "squad:worker-alpha",
      prompt: "first task",
      dispatch_depth: 1,
      message_hop: 0,
      stream_deltas: true,
    });
    await waitFor(() =>
      frames.some(
        (f) => f.type === "host_run_event" && f.run_id === "turn1-run" && f.kind === "completed",
      ),
    );

    // Turn 2 with same external_session_key, no acp_session_id, stream_deltas omitted
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      event_id: "ev-t2",
      run_id: "turn2-run",
      external_session_key: "squad:worker-alpha",
      prompt: "second task",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await waitFor(() =>
      frames.some(
        (f) => f.type === "host_run_event" && f.run_id === "turn2-run" && f.kind === "completed",
      ),
    );

    expect(sessionNewCalls).toBe(1);
    expect(promptsReceived).toHaveLength(2);
    expect(promptsReceived[0]!.sessionId).toBe("persist-sess-1");
    expect(promptsReceived[0]!.text).toContain(DAEMON_INSTRUCTIONS);
    expect(promptsReceived[0]!.text).toContain("first task");

    expect(promptsReceived[1]!.sessionId).toBe("persist-sess-1");
    expect(promptsReceived[1]!.text).not.toContain(DAEMON_INSTRUCTIONS);
    expect(promptsReceived[1]!.text).toBe("second task");

    const t2Ack = ws.frames.find(
      (f) => f.type === "host_run_ack" && f.event_id === "ev-t2",
    );
    expect(t2Ack).toMatchObject({
      type: "host_run_ack",
      event_id: "ev-t2",
      run_id: "turn2-run",
      acp_session_id: "persist-sess-1",
    });

    // Turn 2 did not opt into stream_deltas so only Turn 1 streamed
    const t2Deltas = frames.filter(
      (f) => f.type === "stream_delta" && f.runId === "turn2-run",
    );
    expect(t2Deltas).toHaveLength(0);
    expect(manager.getStateSnapshot().workerSessionCount).toBe(1);
  });

  it("host_run_cancel with external_session_key and close_session=true evicts idle sessions (even without active runState) and active sessions after turn settlement via session/close", async () => {
    const dir = makeTempDir();
    let sessSeq = 0;
    const closedSessions: string[] = [];
    const cancelledSessions: string[] = [];
    const frames: Array<Record<string, unknown>> = [];
    const activeTurnResolvers = new Map<string, () => void>();

    const manager = new AcpSessionManager({
      harness: "codex",
      defaultCwd: dir,
      mcpUrl: "http://127.0.0.1:41203/mcp",
      mcpToken: "tok",
      instanceId: "inst-p2a-close",
      streamCoalesceMs: 30,
      workerOutboxPath: join(dir, "outbox.jsonl"),
      transportFactory: () =>
        new MockAcpTransport((msg, p) => {
          if (msg.method === "initialize") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: { sessionCapabilities: { close: {} } },
              },
            });
          } else if (msg.method === "session/new") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessionId: `close-sess-${++sessSeq}` },
            });
          } else if (msg.method === "session/close") {
            const sid = String((msg.params as { sessionId: string }).sessionId);
            closedSessions.push(sid);
            p.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
          } else if (msg.method === "session/cancel") {
            const sid = String((msg.params as { sessionId: string }).sessionId);
            cancelledSessions.push(sid);
          } else if (msg.method === "session/prompt") {
            const params = msg.params as {
              sessionId: string;
              prompt: Array<{ text?: string }>;
            };
            const text = params.prompt.map((b) => b.text ?? "").join("");
            if (text.includes("__HOLD_ACTIVE__")) {
              p.emit({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: params.sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "partial-before-cancel" },
                  },
                },
              });
              activeTurnResolvers.set(params.sessionId, () => {
                p.emit({
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { stopReason: "cancelled" },
                });
              });
              return;
            }
            p.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "idle-done" },
                },
              },
            });
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { stopReason: "end_turn" },
            });
          }
        }),
      broadcastToCapableFn: (_f, frame) => {
        frames.push(frame);
        return 1;
      },
    });
    cleanups.push(() => manager.shutdown());

    const ws = makeWs();
    const handlers = manager.getInboundHandlers();

    // Case A: Idle session closed by external_session_key without run_id (and even with runState cleared)
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "idle-run-1",
      external_session_key: "squad:idle-key",
      prompt: "quick idle task",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await waitFor(() =>
      frames.some(
        (f) => f.type === "host_run_event" && f.run_id === "idle-run-1" && f.kind === "completed",
      ),
    );
    // Simulate absence of live runState to prove eviction works without runState
    (manager as unknown as { workerRunsById: Map<string, unknown> }).workerRunsById.clear();

    await handlers.onControlFrame!(ws, {
      type: "host_run_cancel",
      event_id: "ev-close-idle",
      external_session_key: "squad:idle-key",
      close_session: true,
    });

    expect(closedSessions).toEqual(["close-sess-1"]);
    expect(manager.getStateSnapshot().workerSessionCount).toBe(0);
    expect(
      ws.frames.some(
        (f) =>
          f.type === "host_run_ack" &&
          f.event_id === "ev-close-idle" &&
          f.acp_session_id === "close-sess-1",
      ),
    ).toBe(true);

    // Continuing the evicted session ID rejects with host_session_expired
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "idle-after-close",
      acp_session_id: "close-sess-1",
      prompt: "should fail",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "idle-after-close" &&
          f.kind === "failed" &&
          f.reason === "host_session_expired",
      ),
    );

    // Case B: Active session marked closeAfterTurn on host_run_cancel(external_session_key, close_session: true), evicted only AFTER turn settles
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "active-run-1",
      external_session_key: "squad:active-key",
      prompt: "__HOLD_ACTIVE__",
      dispatch_depth: 1,
      message_hop: 0,
      stream_deltas: true,
    });
    await waitFor(() => activeTurnResolvers.has("close-sess-2"));
    expect(manager.getStateSnapshot().workerSessionCount).toBe(1);

    await handlers.onControlFrame!(ws, {
      type: "host_run_cancel",
      event_id: "ev-close-active",
      external_session_key: "squad:active-key",
      close_session: true,
      reason: "squad_complete",
    });

    // Session cancel sent and ACK emitted, but session/close NOT called yet while turn is still settling
    expect(cancelledSessions).toEqual(["close-sess-2"]);
    expect(closedSessions).toEqual(["close-sess-1"]);
    expect(manager.getStateSnapshot().workerSessionCount).toBe(1);
    expect(
      ws.frames.some(
        (f) =>
          f.type === "host_run_ack" &&
          f.event_id === "ev-close-active" &&
          f.acp_session_id === "close-sess-2",
      ),
    ).toBe(true);

    // Settle the active turn -> flushes delta, emits cancelled, then evicts & calls session/close
    activeTurnResolvers.get("close-sess-2")!();
    await waitFor(() => closedSessions.includes("close-sess-2"));
    expect(closedSessions).toEqual(["close-sess-1", "close-sess-2"]);
    expect(manager.getStateSnapshot().workerSessionCount).toBe(0);
    expect(
      frames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "active-run-1" &&
          f.kind === "cancelled" &&
          f.reason === "squad_complete",
      ),
    ).toBe(true);
    expect(
      frames.some(
        (f) =>
          f.type === "stream_delta" &&
          f.runId === "active-run-1" &&
          f.delta === "partial-before-cancel",
      ),
    ).toBe(true);
  });

  it("cancelling by external_session_key while a new run allocates skips stale completed runs and honours close_session eviction", async () => {
    const dir = makeTempDir();
    const closedSessions: string[] = [];
    let sessionCount = 0;
    let releaseSecondSessionAlloc: (() => void) | null = null;
    const frames: Array<Record<string, unknown>> = [];

    const manager = new AcpSessionManager({
      harness: "agy",
      defaultCwd: dir,
      mcpUrl: "http://127.0.0.1:41204/mcp",
      mcpToken: "tok",
      instanceId: "inst-p2a-alloc-race",
      workerOutboxPath: join(dir, "outbox.jsonl"),
      transportFactory: () =>
        new MockAcpTransport((msg, p) => {
          if (msg.method === "initialize") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: { sessionCapabilities: { close: {} } },
              },
            });
          } else if (msg.method === "session/new") {
            sessionCount += 1;
            const sid = `alloc-sess-${sessionCount}`;
            if (sessionCount === 2) {
              new Promise<void>((resolve) => {
                releaseSecondSessionAlloc = resolve;
              }).then(() => {
                p.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: sid } });
              });
              return;
            }
            p.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: sid } });
          } else if (msg.method === "session/close") {
            const params = msg.params as { sessionId: string };
            closedSessions.push(params.sessionId);
            p.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
          } else if (msg.method === "session/prompt") {
            p.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          }
        }),
      broadcastToCapableFn: (_feature, frame) => {
        frames.push(frame as unknown as Record<string, unknown>);
        return 1;
      },
    });
    cleanups.push(() => manager.shutdown());

    const ws = makeWs();
    const handlers = manager.getInboundHandlers();

    // Case A (P1 regression): Turn 1 completes so workerSessions.activeRunId is null while
    // workerContextBySessionId still points to Turn 1. A Turn 2 allocation for the same
    // external_session_key must still be resolved & cancelled by external_session_key.
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "race-turn-1",
      external_session_key: "squad:p1-race",
      prompt: "turn 1",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await waitFor(() =>
      frames.some(
        (f) => f.type === "host_run_event" && f.run_id === "race-turn-1" && f.kind === "completed",
      ),
    );

    // Start Turn 2 (yields in allocateWorkerSession) and immediately send cancel before activeRunId binds
    const turn2StartPromise = handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "race-turn-2",
      external_session_key: "squad:p1-race",
      prompt: "turn 2",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await handlers.onControlFrame!(ws, {
      type: "host_run_cancel",
      event_id: "ev-race-p1",
      external_session_key: "squad:p1-race",
      reason: "pause_during_alloc",
    });
    await turn2StartPromise;

    await waitFor(() =>
      frames.some(
        (f) => f.type === "host_run_event" && f.run_id === "race-turn-2" && f.kind === "cancelled",
      ),
    );
    expect(
      frames.some(
        (f) => f.type === "host_run_event" && f.run_id === "race-turn-2" && f.kind === "completed",
      ),
    ).toBe(false);

    // Case B (P2 regression): host_run_cancel with close_session: true while a brand-new session
    // is still awaiting allocateWorkerSession() must evict that session once allocation finishes.
    const freshStartPromise = handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "race-fresh-1",
      external_session_key: "squad:p2-race",
      prompt: "fresh turn",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await waitFor(() => releaseSecondSessionAlloc !== null);

    await handlers.onControlFrame!(ws, {
      type: "host_run_cancel",
      event_id: "ev-race-p2",
      external_session_key: "squad:p2-race",
      close_session: true,
      reason: "conclude_during_alloc",
    });

    // Finish delayed session/new allocation after cancel was processed
    releaseSecondSessionAlloc!();
    await freshStartPromise;
    await waitFor(() => closedSessions.includes("alloc-sess-2"));

    expect(closedSessions).toContain("alloc-sess-2");
    expect(manager.getStateSnapshot().workerSessionCount).toBe(1); // only alloc-sess-1 remains
  });
});
