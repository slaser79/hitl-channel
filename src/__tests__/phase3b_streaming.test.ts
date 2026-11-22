import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { spawnAcpTransport, type AcpTransport } from "../acp_client.js";
import { AcpSessionManager } from "../acp_session_manager.js";
import { startDaemon } from "../daemon.js";
import {
  broadcastReply,
  broadcastToCapable,
  clients,
  replyBuffer,
  sendControlToClient,
  startHttpBridge,
} from "../http_bridge.js";
import { registerHitlTools } from "../mcp_tools.js";
import type {
  HitlWebSocket,
  ReplyPayload,
  StreamDeltaFrame,
  ToolProgressFrame,
  ToolStepSummary,
  TurnStateFrame,
} from "../types.js";

const FAKE_AGENT_PATH = join(import.meta.dir, "fixtures", "fake_acp_agent.ts");

class FakePeerTransport implements AcpTransport {
  readonly pid = 91919;
  sent: Array<Record<string, unknown>> = [];
  private lineCbs: Array<(line: string) => void> = [];
  private closeCbs: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  closed = false;

  constructor(
    private readonly onOutbound: (msg: Record<string, unknown>, peer: FakePeerTransport) => void,
  ) {}

  send(line: string): void {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    this.sent.push(parsed);
    queueMicrotask(() => this.onOutbound(parsed, this));
  }

  onLine(cb: (line: string) => void): void {
    this.lineCbs.push(cb);
  }

  onClose(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.closeCbs.push(cb);
  }

  emit(obj: Record<string, unknown>): void {
    const line = JSON.stringify(obj);
    for (const cb of this.lineCbs) cb(line);
  }

  crash(code = 137): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb(code, null);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb(0, null);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for predicate");
}

function makeMockSocket(opts?: {
  tokenHash?: string;
  features?: string[];
}): HitlWebSocket & { frames: Array<Record<string, unknown>> } {
  const frames: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    data: {
      tokenHash: opts?.tokenHash ?? `ws-${Math.random().toString(36).slice(2, 6)}`,
      ...(opts?.features
        ? { proto: 3, features: new Set(opts.features) }
        : {}),
    },
    send(raw: string) {
      frames.push(JSON.parse(raw) as Record<string, unknown>);
      return 1;
    },
    frames,
  };
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("SPEC-HITL-APP-10827 Milestone 3b AV10: live streaming, tool progress, reconnect snapshot, turn_state & cancel_turn", () => {
  let prevHome: string | undefined;
  let prevApiKey: string | undefined;
  let tempHome: string;
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevApiKey = process.env.HITL_CHANNEL_API_KEY;
    tempHome = mkdtempSync(join(tmpdir(), "hitl-p3b-stream-"));
    process.env.HOME = tempHome;
    clients.clear();
    replyBuffer.drain();
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
    clients.clear();
    replyBuffer.drain();
    process.env.HOME = prevHome;
    if (prevApiKey !== undefined) {
      process.env.HITL_CHANNEL_API_KEY = prevApiKey;
    } else {
      delete process.env.HITL_CHANNEL_API_KEY;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  function createHarness(opts: {
    streamCoalesceMs?: number;
    onOutbound: (msg: Record<string, unknown>, peer: FakePeerTransport, idx: number) => void;
  }) {
    const peers: FakePeerTransport[] = [];
    const replies: Array<{
      id: string;
      text: string;
      messageId?: string;
      acpSessionId?: string | null;
      turnId?: string | null;
      isTurnFinal?: boolean;
      toolSteps?: ToolStepSummary[];
      excludeFeature?: string;
    }> = [];
    const unicastFrames: Array<Record<string, unknown>> = [];

    const manager = new AcpSessionManager({
      harness: "agy",
      defaultCwd: tempHome,
      mcpUrl: "http://127.0.0.1:45601/mcp",
      mcpToken: "tok-3b",
      instanceId: "inst-p3b-unit",
      outOfTurnQuietMs: 30,
      streamCoalesceMs: opts.streamCoalesceMs,
      transportFactory: () => {
        const idx = peers.length;
        const peer = new FakePeerTransport((msg, p) => opts.onOutbound(msg, p, idx));
        peers.push(peer);
        return peer;
      },
      broadcastReplyFn: (text, messageId, agentId, attachments, replyOpts) => {
        const id = broadcastReply(text, messageId, agentId, attachments, replyOpts);
        replies.push({
          id,
          text,
          messageId,
          acpSessionId: replyOpts?.acpSessionId ?? null,
          turnId: replyOpts?.turnId ?? null,
          isTurnFinal: replyOpts?.isTurnFinal,
          toolSteps: replyOpts?.toolSteps,
          excludeFeature: replyOpts?.excludeFeature,
        });
        return id;
      },
      broadcastToCapableFn: (feature, frame) => broadcastToCapable(feature, frame),
      sendControlToClientFn: (ws, frame, requiredFeature) =>
        sendControlToClient(ws, frame, requiredFeature),
      unicastFrameFn: (frame) => {
        unicastFrames.push(frame);
        return { delivered: true, targetDevice: "dev-1" };
      },
      auditFn: async () => {},
    });
    cleanups.push(() => manager.shutdown());

    return {
      manager,
      peers,
      replies,
      unicastFrames,
      handlers: manager.getInboundHandlers(),
    };
  }

  it("isolates legacy client_hello-less sockets and 3a-without-streaming sockets from all 3b frames", async () => {
    const legacyWs = makeMockSocket({ tokenHash: "legacy" });
    const phase3aWs = makeMockSocket({
      tokenHash: "phase3a",
      features: ["sessions", "choices_settled"],
    });
    const streamingWs = makeMockSocket({
      tokenHash: "phase3b",
      features: ["sessions", "choices_settled", "streaming"],
    });
    clients.add(legacyWs);
    clients.add(phase3aWs);
    clients.add(streamingWs);

    const { handlers } = createHarness({
      streamCoalesceMs: 10,
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-iso" } });
        } else if (msg.method === "session/prompt") {
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-iso",
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tc-iso",
                name: "read_file",
                title: "Read file",
                status: "in_progress",
              },
            },
          });
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-iso",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "isolated hello" },
              },
            },
          });
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        }
      },
    });

    await handlers.onClientHello?.(phase3aWs);
    await handlers.onClientHello?.(streamingWs);
    await handlers.onInbound({ text: "hi", meta: {} });
    await waitFor(() =>
      streamingWs.frames.some((f) => f.type === "turn_state" && f.state === "idle" && f.finalReplyId != null),
    );

    const streamingTypes = new Set(["stream_delta", "tool_progress", "turn_state"]);
    expect(legacyWs.frames.some((f) => streamingTypes.has(String(f.type)))).toBe(false);
    expect(phase3aWs.frames.some((f) => streamingTypes.has(String(f.type)))).toBe(false);
    expect(legacyWs.frames.some((f) => f.type === "reply" && f.text === "isolated hello")).toBe(true);
    expect(phase3aWs.frames.some((f) => f.type === "reply" && f.text === "isolated hello")).toBe(true);
    expect(streamingWs.frames.some((f) => f.type === "stream_delta")).toBe(true);
    expect(streamingWs.frames.some((f) => f.type === "tool_progress")).toBe(true);
  });

  it("coalesces chunks within 75ms default window, flushes before final reply/idle, splits >16KB UTF-8 safely, and caps at 256KB with truncated:true once", async () => {
    const streamingWs = makeMockSocket({
      tokenHash: "stream-cap",
      features: ["streaming"],
    });
    clients.add(streamingWs);

    let releaseBurst!: () => void;
    let releaseHuge!: () => void;
    let promptIdx = 0;

    const { manager, handlers } = createHarness({
      // Default streamCoalesceMs (75ms) for turn 1 coalescing verification
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-cap" } });
        } else if (msg.method === "session/prompt") {
          promptIdx++;
          if (promptIdx === 1) {
            // Two small chunks emitted immediately -> must coalesce into ONE frame after 75ms (or on flush)
            peer.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s-cap",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
              },
            });
            peer.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s-cap",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world!" } },
              },
            });
            releaseBurst = () =>
              peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          } else {
            // Turn 2: emit >16KB with 4-byte emojis across boundary AND exceed 256KB total
            const emojiBlock = "a".repeat(16382) + "🚀" + "b".repeat(2000); // > 16KB, emoji straddles 16KB
            const filler256 = "c".repeat(256 * 1024);
            peer.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s-cap",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: emojiBlock } },
              },
            });
            peer.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s-cap",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: filler256 } },
              },
            });
            // Extra chunk after cap already tripped -> must emit zero more stream_delta frames
            peer.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s-cap",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "AFTER_CAP" } },
              },
            });
            releaseHuge = () =>
              peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          }
        }
      },
    });

    // Turn 1: check coalescing delay (not emitted immediately at 20ms, emitted after >75ms)
    await handlers.onInbound({ text: "turn1", meta: {} });
    await waitFor(() => typeof releaseBurst === "function");
    await new Promise((r) => setTimeout(r, 20));
    expect(streamingWs.frames.filter((f) => f.type === "stream_delta").length).toBe(0);

    // Wait past 75ms window -> exactly ONE coalesced stream_delta frame
    await waitFor(() => streamingWs.frames.some((f) => f.type === "stream_delta"));
    const turn1Deltas = streamingWs.frames.filter((f) => f.type === "stream_delta") as unknown as StreamDeltaFrame[];
    expect(turn1Deltas.length).toBe(1);
    expect(turn1Deltas[0]!.delta).toBe("Hello world!");
    expect(turn1Deltas[0]!.seq).toBe(1);
    expect(turn1Deltas[0]!.turnId).toBe(manager.getActiveTurnId()!);

    releaseBurst();
    await waitFor(() =>
      streamingWs.frames.some((f) => f.type === "turn_state" && f.state === "idle"),
    );

    // Turn 2: >16KB emoji boundary + >256KB cap
    streamingWs.frames.length = 0;
    await handlers.onInbound({ text: "turn2", meta: {} });
    await waitFor(() => typeof releaseHuge === "function");
    releaseHuge();
    await waitFor(() =>
      streamingWs.frames.some((f) => f.type === "turn_state" && f.state === "idle"),
    );

    const turn2Deltas = streamingWs.frames.filter((f) => f.type === "stream_delta") as unknown as StreamDeltaFrame[];
    expect(turn2Deltas.length).toBeGreaterThan(15);
    let totalEmittedBytes = 0;
    let truncatedCount = 0;
    for (let i = 0; i < turn2Deltas.length; i++) {
      const f = turn2Deltas[i]!;
      expect(f.seq).toBe(i + 1);
      expect(hasLoneSurrogate(f.delta)).toBe(false);
      const b = Buffer.byteLength(f.delta, "utf8");
      expect(b).toBeLessThanOrEqual(16 * 1024);
      totalEmittedBytes += b;
      if (f.truncated === true) truncatedCount++;
    }
    expect(totalEmittedBytes).toBeLessThanOrEqual(256 * 1024);
    expect(truncatedCount).toBe(1);
    expect(turn2Deltas.at(-1)?.truncated).toBe(true);
    // Final durable reply still delivers the FULL untruncated text!
    const finalReply = streamingWs.frames.find((f) => f.type === "reply" && f.isTurnFinal === true) as unknown as ReplyPayload;
    expect(finalReply).toBeDefined();
    expect(finalReply.text).toContain("AFTER_CAP");
    expect(finalReply.text).toContain("🚀");

    // Verify ordering: all stream_deltas arrive BEFORE terminal reply, which arrives BEFORE turn_state(idle)
    const lastDeltaIdx = streamingWs.frames.findLastIndex((f) => f.type === "stream_delta");
    const finalReplyIdx = streamingWs.frames.findIndex((f) => f.type === "reply" && f.isTurnFinal === true);
    const idleIdx = streamingWs.frames.findLastIndex((f) => f.type === "turn_state" && f.state === "idle");
    expect(lastDeltaIdx).toBeLessThan(finalReplyIdx);
    expect(finalReplyIdx).toBeLessThan(idleIdx);
  });

  it("emits truncated:true once even when earlier chunks hit exact 256KB boundary before overflowing", async () => {
    const streamingWs = makeMockSocket({ features: ["streaming"] });
    clients.add(streamingWs);
    let releaseTurn!: () => void;

    const { handlers } = createHarness({
      streamCoalesceMs: 0,
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-exact" } });
        } else if (msg.method === "session/prompt") {
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-exact",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(256 * 1024) } },
            },
          });
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-exact",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "overflow" } },
            },
          });
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-exact",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "more-overflow" } },
            },
          });
          releaseTurn = () =>
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        }
      },
    });

    await handlers.onInbound({ text: "exact-boundary", meta: {} });
    await waitFor(() => typeof releaseTurn === "function");
    releaseTurn();
    await waitFor(() =>
      streamingWs.frames.some((f) => f.type === "turn_state" && f.state === "idle"),
    );

    const deltas = streamingWs.frames.filter((f) => f.type === "stream_delta") as unknown as StreamDeltaFrame[];
    expect(deltas.filter((d) => d.truncated === true)).toHaveLength(1);
    expect(deltas.reduce((n, d) => n + Buffer.byteLength(d.delta, "utf8"), 0)).toBe(256 * 1024);
    expect(deltas.at(-1)?.delta).toBe("");
    expect(deltas.at(-1)?.truncated).toBe(true);
  });

  it("tracks tool_progress lifecycle, truncates 512/256 summaries, caps durable toolSteps at 32, and finalizes unfinished steps on end_turn and cancel", async () => {
    const streamingWs = makeMockSocket({ features: ["streaming"] });
    clients.add(streamingWs);

    let promptNum = 0;
    let releaseCancelTurn!: () => void;

    const { handlers } = createHarness({
      streamCoalesceMs: 10,
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-tools" } });
        } else if (msg.method === "session/prompt") {
          promptNum++;
          if (promptNum === 1) {
            // Emit 35 tool calls; first 34 complete with 600-char output, #35 stays in_progress when turn ends
            for (let i = 1; i <= 35; i++) {
              const id = `tc-${i}`;
              peer.emit({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: "s-tools",
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: id,
                    name: `tool_${i}`,
                    title: `Tool ${i}`,
                    kind: "execute",
                    rawInput: { n: i },
                  },
                },
              });
              if (i < 35) {
                peer.emit({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: "s-tools",
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: id,
                      status: "completed",
                      rawOutput: "Y".repeat(600),
                    },
                  },
                });
              } else {
                peer.emit({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: "s-tools",
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: id,
                      status: "in_progress",
                    },
                  },
                });
              }
            }
            peer.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s-tools",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done tools" } },
              },
            });
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          } else {
            // Turn 2: pending tool cancelled via cancel_turn -> finalized to failed/"Cancelled"
            peer.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s-tools",
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: "tc-cancel-1",
                  name: "bash",
                  title: "Long cmd",
                  status: "pending",
                },
              },
            });
            releaseCancelTurn = () =>
              peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "cancelled" } });
          }
        } else if (msg.method === "session/cancel") {
          releaseCancelTurn?.();
        }
      },
    });

    await handlers.onInbound({ text: "run 35 tools", meta: {} });
    await waitFor(() =>
      streamingWs.frames.some((f) => f.type === "turn_state" && f.state === "idle"),
    );

    const progressFrames = streamingWs.frames.filter(
      (f) => f.type === "tool_progress",
    ) as unknown as ToolProgressFrame[];
    expect(progressFrames.length).toBe(70);
    // Ephemeral summary capped at 512 chars
    const completedProgress = progressFrames.find(
      (f) => f.toolCallId === "tc-1" && f.status === "completed",
    )!;
    expect(completedProgress.summary?.length).toBe(512);
    // Ephemeral tool_progress does not include isTurnFinal
    expect("isTurnFinal" in completedProgress).toBe(false);

    const reply1 = streamingWs.frames.find(
      (f) => f.type === "reply" && f.isTurnFinal === true,
    ) as unknown as ReplyPayload;
    expect(reply1).toBeDefined();
    expect(reply1.toolSteps).toBeDefined();
    expect(reply1.toolSteps!.length).toBe(32);
    // Durable summary capped at 256 chars
    expect(reply1.toolSteps![0]!.summary?.length).toBe(256);
    // Unfinished #35 finalized to failed / "Interrupted" on non-cancel end_turn
    const lastStep = reply1.toolSteps!.find((s) => s.toolCallId === "tc-35")!;
    expect(lastStep.status).toBe("failed");
    expect(lastStep.summary).toBe("Interrupted");

    // Turn 2: cancel_turn finalizes unfinished tool to failed / "Cancelled"
    streamingWs.frames.length = 0;
    await handlers.onInbound({ text: "cancel tool turn", meta: {} });
    await waitFor(() => typeof releaseCancelTurn === "function");
    await handlers.onControlFrame?.(streamingWs, { type: "cancel_turn" });
    await waitFor(() =>
      streamingWs.frames.some((f) => f.type === "turn_state" && f.state === "idle"),
    );

    const reply2 = streamingWs.frames.find(
      (f) => f.type === "reply" && f.isTurnFinal === true,
    ) as unknown as ReplyPayload;
    expect(reply2.text).toBe("⏹ cancelled");
    expect(reply2.toolSteps).toEqual([
      {
        toolCallId: "tc-cancel-1",
        name: "bash",
        title: "Long cmd",
        status: "failed",
        summary: "Cancelled",
      },
    ]);
  });

  it("stamps turnId on interim reply_to_hitl, present_choices_to_hitl, and permissions WITHOUT isTurnFinal:true, and sets finalReplyId=null on sole-reply_to_hitl turns", async () => {
    const streamingWs = makeMockSocket({ features: ["streaming"] });
    clients.add(streamingWs);

    let turnIdFromToolDuringTurn: string | null = null;
    const mcp = new Server(
      { name: "hitl-channel", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    let mgr!: AcpSessionManager;
    registerHitlTools(mcp, {
      mode: "daemon",
      getFallbackAcpSessionId: () => mgr.getAttributionSessionId(),
      getFallbackTurnId: () => mgr.getActiveTurnId(),
      onChoicesPresented: (id) => mgr.onChoicesPresented(id),
      onReplySent: (sid) => mgr.onReplySent(sid),
    });
    const callTool = (mcp as any)._requestHandlers.get("tools/call");

    let releasePermTurn!: () => void;
    let promptCount = 0;

    const { manager, unicastFrames, handlers } = createHarness({
      streamCoalesceMs: 10,
      onOutbound: async (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-mcp" } });
        } else if (msg.method === "session/prompt") {
          promptCount++;
          if (promptCount === 1) {
            // Sole reply_to_hitl output, zero agent_message_chunk
            turnIdFromToolDuringTurn = mgr.getActiveTurnId();
            await callTool({
              method: "tools/call",
              params: { name: "reply_to_hitl", arguments: { text: "sole interim" } },
            });
            await callTool({
              method: "tools/call",
              params: {
                name: "present_choices_to_hitl",
                arguments: { prompt: "Continue?", choices: ["Yes", "No"] },
              },
            });
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          } else {
            // Turn 2: permission park (waiting_approval -> running -> idle) + normal reply
            peer.emit({
              jsonrpc: "2.0",
              id: 501,
              method: "session/request_permission",
              params: {
                sessionId: "s-mcp",
                toolCall: { toolCallId: "tc-p", name: "bash", title: "Run echo" },
                options: [
                  { optionId: "allow", name: "Allow", kind: "allow_once" },
                  { optionId: "deny", name: "Deny", kind: "reject_once" },
                ],
              },
            });
            releasePermTurn = () => {
              peer.emit({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: "s-mcp",
                  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after perm" } },
                },
              });
              peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
            };
          }
        }
      },
    });
    mgr = manager;

    await handlers.onInbound({ text: "sole reply", meta: {} });
    await waitFor(() =>
      streamingWs.frames.some((f) => f.type === "turn_state" && f.state === "idle"),
    );

    const interimReply = streamingWs.frames.find(
      (f) => f.type === "reply" && f.text === "sole interim",
    ) as unknown as ReplyPayload;
    expect(interimReply).toBeDefined();
    expect(interimReply.turnId).toBe(turnIdFromToolDuringTurn!);
    expect(interimReply.isTurnFinal).toBeUndefined();

    const userChoice = streamingWs.frames.find(
      (f) => f.type === "choices" && f.category === "choice",
    );
    expect(userChoice?.turnId).toBe(turnIdFromToolDuringTurn!);
    expect("isTurnFinal" in (userChoice ?? {})).toBe(false);

    const idle1 = streamingWs.frames.find(
      (f) => f.type === "turn_state" && f.state === "idle",
    ) as unknown as TurnStateFrame;
    expect(idle1.finalReplyId).toBeNull();
    expect(idle1.turnId).toBe(turnIdFromToolDuringTurn!);

    // Turn 2: waiting_approval -> running -> idle with concrete finalReplyId
    streamingWs.frames.length = 0;
    unicastFrames.length = 0;
    await handlers.onInbound({ text: "Choice Yes", meta: {} });
    await waitFor(() =>
      streamingWs.frames.some(
        (f) => f.type === "turn_state" && f.state === "waiting_approval",
      ),
    );
    const permFrame = unicastFrames.find((f) => f.category === "permission")!;
    expect(permFrame.turnId).toBe(manager.getActiveTurnId()!);
    expect("isTurnFinal" in permFrame).toBe(false);

    await handlers.onInbound({
      text: "Allow",
      meta: { type: "choice_response", choices_id: String(permFrame.id), option_id: "allow" },
    });
    await waitFor(() =>
      streamingWs.frames.some((f) => f.type === "turn_state" && f.state === "running" && streamingWs.frames.findIndex((x) => x.state === "waiting_approval") < streamingWs.frames.lastIndexOf(f)),
    );
    releasePermTurn();
    await waitFor(() =>
      streamingWs.frames.some((f) => f.type === "turn_state" && f.state === "idle"),
    );

    const turn2Final = streamingWs.frames.find(
      (f) => f.type === "reply" && f.isTurnFinal === true,
    ) as unknown as ReplyPayload;
    const idle2 = streamingWs.frames.find(
      (f) => f.type === "turn_state" && f.state === "idle",
    ) as unknown as TurnStateFrame;
    expect(idle2.finalReplyId).toBe(turn2Final.id);
    const stateSeq = streamingWs.frames
      .filter((f) => f.type === "turn_state")
      .map((f) => (f as unknown as TurnStateFrame).state);
    expect(stateSeq).toEqual(["running", "waiting_approval", "running", "idle"]);
  });

  it("suppresses '⏳ queued (N ahead)' on streaming sockets & replyBuffer when only streaming connected, while preserving for legacy sockets", async () => {
    const streamingWs = makeMockSocket({ tokenHash: "stream-q", features: ["streaming"] });
    clients.add(streamingWs);

    let releaseFirst!: () => void;
    const promptOrder: string[] = [];

    const { handlers } = createHarness({
      streamCoalesceMs: 10,
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-q" } });
        } else if (msg.method === "session/prompt") {
          const text = String(((msg.params as any).prompt[0] as any).text);
          promptOrder.push(text);
          if (text === "first") {
            releaseFirst = () => {
              peer.emit({
                jsonrpc: "2.0",
                method: "session/update",
                params: { sessionId: "s-q", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done-1" } } },
              });
              peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
            };
            return;
          }
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "s-q", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done-2" } } },
          });
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        }
      },
    });

    await handlers.onInbound({ text: "first", meta: {} });
    await waitFor(() => typeof releaseFirst === "function");

    // Queue while ONLY streamingWs is connected -> NO queued reply sent AND NO replyBuffer push
    await handlers.onInbound({ text: "second", meta: {} });
    expect(
      streamingWs.frames.some((f) => f.type === "reply" && String(f.text).includes("queued")),
    ).toBe(false);
    expect(
      replyBuffer.peek().some((e) => e.payload.text.includes("queued")),
    ).toBe(false);
    const queuedState = streamingWs.frames.findLast(
      (f) => f.type === "turn_state",
    ) as unknown as TurnStateFrame;
    expect(queuedState.state).toBe("running");
    expect(queuedState.queueDepth).toBe(1);

    // Connect a legacy socket too -> third queued message goes ONLY to legacyWs (+ replyBuffer), NEVER streamingWs
    const legacyWs = makeMockSocket({ tokenHash: "legacy-q" });
    clients.add(legacyWs);
    await handlers.onInbound({ text: "third", meta: {} });
    expect(
      streamingWs.frames.some((f) => f.type === "reply" && String(f.text).includes("queued")),
    ).toBe(false);
    expect(
      legacyWs.frames.some((f) => f.type === "reply" && f.text === "⏳ queued (2 ahead)"),
    ).toBe(true);
    expect(
      replyBuffer.peek().some((e) => e.payload.text === "⏳ queued (2 ahead)"),
    ).toBe(true);

    releaseFirst();
    await waitFor(() => promptOrder.length === 3);
    await waitFor(() =>
      streamingWs.frames.some(
        (f) => f.type === "turn_state" && f.state === "idle" && f.queueDepth === 0,
      ),
    );
  });

  it("delivers mid-turn reconnect snapshot: turn_state, stream_delta{reset:true} <= 128KB (truncated if exceeded), and live tool_progress", async () => {
    const firstClient = makeMockSocket({ tokenHash: "c1", features: ["streaming"] });
    clients.add(firstClient);

    let emitSecondHalf!: () => void;
    let finishTurn!: () => void;

    const { manager, handlers } = createHarness({
      // Long coalesce window so a buffered delta is still pending when second client connects!
      streamCoalesceMs: 500,
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-reconn" } });
        } else if (msg.method === "session/prompt") {
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-reconn",
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tc-live-1",
                name: "grep",
                title: "Search codebase",
                kind: "search",
                status: "in_progress",
                rawInput: { q: "stream_delta" },
              },
            },
          });
          // > 128KB prefix with emoji near boundary
          const bigChunk = "z".repeat(128 * 1024 - 2) + "🚀" + "tail";
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-reconn",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: bigChunk } },
            },
          });
          emitSecondHalf = () =>
            peer.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s-reconn",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " + tail2" } },
              },
            });
          finishTurn = () =>
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        }
      },
    });

    await handlers.onInbound({ text: "mid-turn test", meta: {} });
    await waitFor(() => typeof emitSecondHalf === "function");

    // Reconnecting client connects mid-turn while bigChunk is still pending in coalesce timer!
    const reconnectedWs = makeMockSocket({ tokenHash: "c2", features: ["streaming"] });
    clients.add(reconnectedWs);
    await handlers.onClientHello?.(reconnectedWs);

    const reconnTurnState = reconnectedWs.frames[0] as unknown as TurnStateFrame;
    expect(reconnTurnState.type).toBe("turn_state");
    expect(reconnTurnState.state).toBe("running");
    expect(reconnTurnState.sessionId).toBe("s-reconn");
    expect(reconnTurnState.turnId).toBe(manager.getActiveTurnId()!);

    // Should NOT receive a non-reset duplicate delta before its reset:true snapshot!
    const reconnDeltas = reconnectedWs.frames.filter(
      (f) => f.type === "stream_delta",
    ) as unknown as StreamDeltaFrame[];
    expect(reconnDeltas).toHaveLength(1);
    expect(reconnDeltas[0]!.reset).toBe(true);
    expect(reconnDeltas[0]!.truncated).toBe(true);
    expect(hasLoneSurrogate(reconnDeltas[0]!.delta)).toBe(false);
    expect(Buffer.byteLength(reconnDeltas[0]!.delta, "utf8")).toBeLessThanOrEqual(128 * 1024);

    const reconnTool = reconnectedWs.frames.find(
      (f) => f.type === "tool_progress",
    ) as unknown as ToolProgressFrame;
    expect(reconnTool).toMatchObject({
      type: "tool_progress",
      sessionId: "s-reconn",
      turnId: manager.getActiveTurnId()!,
      toolCallId: "tc-live-1",
      name: "grep",
      title: "Search codebase",
      kind: "search",
      status: "in_progress",
    });

    // Subsequent delta advances seq cleanly after snapshot seq
    emitSecondHalf();
    finishTurn();
    await waitFor(() =>
      reconnectedWs.frames.some((f) => f.type === "turn_state" && f.state === "idle"),
    );
    const postReconnDeltas = reconnectedWs.frames.filter(
      (f) => f.type === "stream_delta" && !f.reset,
    ) as unknown as StreamDeltaFrame[];
    expect(postReconnDeltas.length).toBe(1);
    expect(postReconnDeltas[0]!.seq).toBeGreaterThan(reconnDeltas[0]!.seq);
    expect(postReconnDeltas[0]!.delta).toBe(" + tail2");
  });

  it("flushes pending deltas and emits turn_state(idle) on handleHarnessExit and shutdown", async () => {
    const streamingWs = makeMockSocket({ features: ["streaming"] });
    clients.add(streamingWs);

    // 1. handleHarnessExit mid-turn
    const crashHarness = createHarness({
      streamCoalesceMs: 500,
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-crash" } });
        } else if (msg.method === "session/prompt") {
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-crash",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before-crash" } },
            },
          });
        }
      },
    });
    await crashHarness.handlers.onInbound({ text: "go", meta: {} });
    await waitFor(() => crashHarness.peers[0]?.sent.some((m) => m.method === "session/prompt") ?? false);
    const activeTurnIdBeforeCrash = crashHarness.manager.getActiveTurnId()!;
    crashHarness.peers[0]!.crash(137);

    expect(
      streamingWs.frames.some((f) => f.type === "stream_delta" && f.delta === "before-crash"),
    ).toBe(true);
    const crashIdle = streamingWs.frames.findLast(
      (f) => f.type === "turn_state" && f.state === "idle",
    ) as unknown as TurnStateFrame;
    expect(crashIdle).toBeDefined();
    expect(crashIdle.turnId).toBe(activeTurnIdBeforeCrash);
    expect(crashIdle.sessionId).toBeNull();
    expect(crashIdle.finalReplyId).toBeNull();

    // 2. shutdown() mid-turn
    streamingWs.frames.length = 0;
    const shutdownHarness = createHarness({
      streamCoalesceMs: 500,
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-shut" } });
        } else if (msg.method === "session/prompt") {
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-shut",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before-shutdown" } },
            },
          });
        }
      },
    });
    await shutdownHarness.handlers.onInbound({ text: "go2", meta: {} });
    await waitFor(() => shutdownHarness.peers[0]?.sent.some((m) => m.method === "session/prompt") ?? false);
    await shutdownHarness.manager.shutdown();

    expect(
      streamingWs.frames.some((f) => f.type === "stream_delta" && f.delta === "before-shutdown"),
    ).toBe(true);
    const shutIdle = streamingWs.frames.findLast(
      (f) => f.type === "turn_state" && f.state === "idle",
    ) as unknown as TurnStateFrame;
    expect(shutIdle).toBeDefined();
    expect(shutIdle.state).toBe("idle");
    expect(shutIdle.finalReplyId).toBeNull();
  });

  it("end-to-end startDaemon over real WS: GET /instance streaming:true, client_hello idle state, cancel_turn isolation, and sessionId mismatch guard", async () => {
    const dir = tempHome;
    process.env.HITL_CHANNEL_API_KEY = "p3b-e2e-key";
    const daemon = await startDaemon({
      harness: "agy",
      port: 0,
      cwd: dir,
      enableMdns: false,
      enableDesktopNotifications: false,
      streamCoalesceMs: 10,
      transportFactory: (_c, _a, opts) =>
        spawnAcpTransport(process.execPath, ["run", FAKE_AGENT_PATH], {
          cwd: opts?.cwd,
        }),
    });
    cleanups.push(() => daemon.shutdown());

    // 1. GET /instance reports capabilities.streaming === true
    const instRes = await fetch(`http://127.0.0.1:${daemon.port}/instance`);
    expect(instRes.status).toBe(200);
    const instJson = (await instRes.json()) as {
      capabilities: { sessions: boolean; streaming: boolean; choicesId: boolean };
    };
    expect(instJson.capabilities).toEqual({
      sessions: true,
      streaming: true,
      choicesId: true,
    });

    // 2. Connect streaming WS and legacy WS
    const streamFrames: Array<Record<string, unknown>> = [];
    const legacyFrames: Array<Record<string, unknown>> = [];

    const openWs = async (sink: Array<Record<string, unknown>>) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${daemon.port}/ws?api_key=p3b-e2e-key`,
      );
      cleanups.push(() => ws.close());
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = (e) => reject(e);
      });
      ws.onmessage = (ev) => {
        const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
        sink.push(frame);
        if (frame.type === "reply" && frame.id) {
          ws.send(JSON.stringify({ type: "ack", id: frame.id }));
        }
      };
      return ws;
    };

    const wsStream = await openWs(streamFrames);
    await openWs(legacyFrames);

    wsStream.send(
      JSON.stringify({
        type: "client_hello",
        proto: 3,
        features: ["sessions", "choices_settled", "streaming"],
      }),
    );

    await waitFor(() =>
      streamFrames.some((f) => f.type === "turn_state" && f.state === "idle"),
    );
    const initTurnState = streamFrames.find((f) => f.type === "turn_state")!;
    expect(initTurnState.sessionId).toBeNull();
    expect(initTurnState.queueDepth).toBe(0);

    // cancel_turn when idle -> NO "nothing running" reply (unlike /cancel)
    wsStream.send(JSON.stringify({ type: "cancel_turn", requestId: "c-idle" }));
    await new Promise((r) => setTimeout(r, 60));
    expect(streamFrames.some((f) => f.type === "reply")).toBe(false);
    expect(legacyFrames.some((f) => f.type === "reply")).toBe(false);

    // Start waiting turn via POST /
    streamFrames.length = 0;
    await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: {
        authorization: "Bearer p3b-e2e-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "__WAIT_CANCEL__" }),
    });
    await waitFor(() =>
      streamFrames.some((f) => f.type === "turn_state" && f.state === "running"),
    );

    // Mismatched sessionId cancel_turn must NOT cancel the active session
    wsStream.send(
      JSON.stringify({ type: "cancel_turn", sessionId: "wrong-session-id" }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(daemon.manager.getActiveTurnId()).not.toBeNull();

    // Matching cancel_turn cleanly cancels the running turn
    wsStream.send(
      JSON.stringify({ type: "cancel_turn", sessionId: "fake-sess-1" }),
    );
    await waitFor(() =>
      streamFrames.some((f) => f.type === "turn_state" && f.state === "idle"),
    );
    const cancelReply = streamFrames.find(
      (f) => f.type === "reply" && f.isTurnFinal === true,
    ) as unknown as ReplyPayload;
    expect(cancelReply.text).toBe("⏹ cancelled");
    expect(legacyFrames.some((f) => f.type === "turn_state")).toBe(false);

    // Real loopback MCP reply_to_hitl sole-output turn -> reply gets turnId WITHOUT isTurnFinal, idle turn_state gets finalReplyId: null
    streamFrames.length = 0;
    await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: {
        authorization: "Bearer p3b-e2e-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "__REPLY_IMAGE__:ignored" }),
    });
    await waitFor(() =>
      streamFrames.some((f) => f.type === "turn_state" && f.state === "idle"),
    );
    const e2eInterim = streamFrames.find(
      (f) => f.type === "reply" && f.text === "interim image",
    ) as unknown as ReplyPayload;
    expect(e2eInterim).toBeDefined();
    expect(typeof e2eInterim.turnId).toBe("string");
    expect(e2eInterim.turnId!.length).toBeGreaterThan(0);
    expect(e2eInterim.isTurnFinal).toBeUndefined();
    const e2eSoleIdle = streamFrames.find(
      (f) => f.type === "turn_state" && f.state === "idle",
    ) as unknown as TurnStateFrame;
    expect(e2eSoleIdle.finalReplyId).toBeNull();
    expect(e2eSoleIdle.turnId).toBe(e2eInterim.turnId);

    // Normal turn over real WS -> stream_delta + isTurnFinal reply + turn_state(idle).finalReplyId === reply.id
    streamFrames.length = 0;
    await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: {
        authorization: "Bearer p3b-e2e-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "hello streaming" }),
    });
    await waitFor(() =>
      streamFrames.some((f) => f.type === "turn_state" && f.state === "idle"),
    );
    const e2eDelta = streamFrames.find((f) => f.type === "stream_delta") as unknown as StreamDeltaFrame;
    const e2eFinal = streamFrames.find(
      (f) => f.type === "reply" && f.isTurnFinal === true,
    ) as unknown as ReplyPayload;
    const e2eIdle = streamFrames.find(
      (f) => f.type === "turn_state" && f.state === "idle",
    ) as unknown as TurnStateFrame;
    expect(e2eDelta.delta).toBe("echo:hello streaming");
    expect(e2eFinal.text).toBe("echo:hello streaming");
    expect(e2eFinal.turnId).toBe(e2eDelta.turnId);
    expect(e2eIdle.finalReplyId).toBe(e2eFinal.id);

    // Also verify channel-mode startHttpBridge still defaults streaming: false & routes cancel_turn to onControlFrame (never onInbound)
    let channelInboundCount = 0;
    let channelControlCount = 0;
    const chBridge = startHttpBridge(
      {
        async onInbound() {
          channelInboundCount++;
        },
        async onPairingCode() {},
        onControlFrame() {
          channelControlCount++;
        },
      },
      { port: 0 },
    );
    cleanups.push(() => chBridge.stop(true));
    const chInst = (await (
      await fetch(`http://127.0.0.1:${chBridge.port}/instance`)
    ).json()) as { capabilities: { streaming: boolean } };
    expect(chInst.capabilities.streaming).toBe(false);

    const wsCh = new WebSocket(
      `ws://127.0.0.1:${chBridge.port}/ws?api_key=p3b-e2e-key`,
    );
    cleanups.push(() => wsCh.close());
    await new Promise<void>((resolve, reject) => {
      wsCh.onopen = () => resolve();
      wsCh.onerror = (e) => reject(e);
    });
    wsCh.send(JSON.stringify({ type: "cancel_turn" }));
    await waitFor(() => channelControlCount === 1);
    expect(channelInboundCount).toBe(0);
  });
});
