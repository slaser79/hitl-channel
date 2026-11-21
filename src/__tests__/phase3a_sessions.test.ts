import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { spawnAcpTransport, type AcpTransport } from "../acp_client.js";
import { AcpSessionManager } from "../acp_session_manager.js";
import { FrameCorrelator } from "../correlator.js";
import { startDaemon } from "../daemon.js";
import {
  clients,
  replyBuffer,
  sendControlToClient,
} from "../http_bridge.js";
import { registerHitlTools } from "../mcp_tools.js";
import { presentQuestionsToHitl } from "../questions_batch.js";
import type {
  HitlWebSocket,
  QuestionsBatchRequestFrame,
  RecentTurnSummary,
  ReplyPayload,
} from "../types.js";

class FakePeerTransport implements AcpTransport {
  readonly pid = 88888;
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

  crash(code = 1): void {
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

function makeCapableWs(features = ["sessions", "choices_settled"]): HitlWebSocket & {
  frames: Array<Record<string, unknown>>;
} {
  const frames: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    data: {
      tokenHash: `ws-${Math.random().toString(36).slice(2, 6)}`,
      proto: 3,
      features: new Set(features),
    },
    send(raw: string) {
      frames.push(JSON.parse(raw) as Record<string, unknown>);
      return 1;
    },
    frames,
  };
}

describe("SPEC-HITL-APP-10827 Milestone 3a AV4 & AV6: sessions, caps, resume tail, timeout, acpSessionId", () => {
  let prevHome: string | undefined;
  let prevApiKey: string | undefined;
  let tempHome: string;
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevApiKey = process.env.HITL_CHANNEL_API_KEY;
    tempHome = mkdtempSync(join(tmpdir(), "hitl-p3a-sess-"));
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

  function createSessionManagerHarness(opts: {
    harness?: "agy" | "codex" | "hermes";
    sessionLoadTimeoutMs?: number;
    onOutbound: (msg: Record<string, unknown>, peer: FakePeerTransport, spawnIdx: number) => void;
  }) {
    const peers: FakePeerTransport[] = [];
    const replies: Array<{
      text: string;
      messageId?: string;
      acpSessionId?: string | null;
    }> = [];
    const capableBroadcasts: Array<{ feature: string; frame: Record<string, unknown> }> = [];
    const controlUnicasts: Array<{ ws: HitlWebSocket; frame: Record<string, unknown> }> = [];

    const manager = new AcpSessionManager({
      harness: opts.harness ?? "agy",
      defaultCwd: tempHome,
      mcpUrl: "http://127.0.0.1:45556/mcp",
      mcpToken: "tok",
      instanceId: "inst-p3a-sess",
      outOfTurnQuietMs: 30,
      sessionLoadTimeoutMs: opts.sessionLoadTimeoutMs,
      transportFactory: () => {
        const idx = peers.length;
        const p = new FakePeerTransport((msg, peer) => opts.onOutbound(msg, peer, idx));
        peers.push(p);
        return p;
      },
      broadcastReplyFn: (text, messageId, _agentId, _atts, replyOpts) => {
        replies.push({ text, messageId, acpSessionId: replyOpts?.acpSessionId ?? null });
        return `r-${replies.length}`;
      },
      broadcastToCapableFn: (feature, frame) => {
        capableBroadcasts.push({ feature, frame });
        let sent = 0;
        for (const ws of Array.from(clients)) {
          if (ws.readyState === 1 && ws.data?.features?.has(feature)) {
            ws.send(JSON.stringify(frame));
            sent++;
          }
        }
        return sent;
      },
      sendControlToClientFn: (ws, frame, requiredFeature) => {
        controlUnicasts.push({ ws, frame });
        return sendControlToClient(ws, frame, requiredFeature);
      },
      unicastFrameFn: () => ({ delivered: true, targetDevice: "dev-1" }),
      auditFn: async () => {},
    });

    return {
      manager,
      peers,
      replies,
      capableBroadcasts,
      controlUnicasts,
      handlers: manager.getInboundHandlers(),
    };
  }

  it("AV6: stamps acpSessionId on reply_to_hitl, present_choices_to_hitl (+category='choice' & onChoicesPresented(id)), present_questions_to_hitl, and broadcastReply", async () => {
    const mockWs = makeCapableWs();
    clients.add(mockWs);

    // 1. Daemon MCP tools: reply_to_hitl, present_choices_to_hitl, present_questions_to_hitl
    const presentedIds: string[] = [];
    const daemonMcp = new Server(
      { name: "hitl-channel", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    registerHitlTools(daemonMcp, {
      mode: "daemon",
      requestAcpSessionId: "sess-mcp-1",
      onChoicesPresented: (id) => presentedIds.push(id),
    });
    const daemonCall = (daemonMcp as any)._requestHandlers.get("tools/call");

    await daemonCall({
      method: "tools/call",
      params: {
        name: "reply_to_hitl",
        arguments: { text: "daemon interim" },
        _meta: { "antigravity.google/conversation_id": "sess-meta-9" },
      },
    });
    const replyFrame = mockWs.frames.find(
      (f) => f.type === "reply" && f.text === "daemon interim",
    ) as unknown as ReplyPayload;
    expect(replyFrame).toBeDefined();
    expect(replyFrame.content).toBe("daemon interim");
    expect(replyFrame.acpSessionId).toBe("sess-meta-9");

    await daemonCall({
      method: "tools/call",
      params: {
        name: "present_choices_to_hitl",
        arguments: { prompt: "Pick one", choices: ["A", "B"] },
      },
    });
    const choiceFrame = mockWs.frames.find((f) => f.type === "choices")!;
    expect(choiceFrame.category).toBe("choice");
    expect(choiceFrame.acpSessionId).toBe("sess-mcp-1");
    expect(presentedIds).toEqual([String(choiceFrame.id)]);

    await daemonCall({
      method: "tools/call",
      params: {
        name: "present_questions_to_hitl",
        arguments: {
          questions: [{ header: "Env", question: "Which?", choices: ["Dev", "Prod"] }],
        },
      },
    });
    const qFrame = mockWs.frames.find(
      (f) => f.type === "questions_batch_request",
    ) as unknown as QuestionsBatchRequestFrame;
    expect(qFrame.acpSessionId).toBe("sess-mcp-1");

    // 2. Direct presentQuestionsToHitl omits acpSessionId when absent/empty
    const emitted: Array<Record<string, unknown>> = [];
    await presentQuestionsToHitl(
      { questions: [{ header: "Env", question: "Which?", choices: ["Dev", "Prod"] }] },
      {
        correlator: new FrameCorrelator(),
        unicastFrame: (f) => {
          emitted.push(f);
          return { delivered: true, targetDevice: "dev" };
        },
        clientsSize: () => 1,
        instanceId: "inst-ch",
        generateRequestId: () => "req-ch-1",
        audit: async () => {},
      },
    );
    expect("acpSessionId" in emitted[0]!).toBe(false);

    // 3. Channel mode reply_to_hitl omits acpSessionId
    mockWs.frames.length = 0;
    const channelMcp = new Server(
      { name: "hitl-channel", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    registerHitlTools(channelMcp, { mode: "channel" });
    const channelCall = (channelMcp as any)._requestHandlers.get("tools/call");
    await channelCall({
      method: "tools/call",
      params: { name: "reply_to_hitl", arguments: { text: "channel reply" } },
    });
    const chReply = mockWs.frames.find((f) => f.text === "channel reply")!;
    expect("acpSessionId" in chReply).toBe(false);
  });

  it("AV4: caps session_list at <=50 sessions (including active outside top 50) & <=8 recentCwds MRU, validates invalid_cwd, blocks turn_busy, and broadcasts on all activeSessionId transitions", async () => {
    const dirA = join(tempHome, "proj-a");
    const dirB = join(tempHome, "proj-b");
    const lockedDir = join(tempHome, "locked-dir");
    const regularFile = join(tempHome, "not-a-dir.txt");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    mkdirSync(lockedDir, { recursive: true });
    writeFileSync(regularFile, "hello", "utf8");

    let sessionSeq = 0;
    let holdPromptResolve: (() => void) | null = null;
    const promptMethods: string[] = [];

    const catalog = Array.from({ length: 60 }, (_, i) => ({
      sessionId: `cat-${i + 1}`,
      title: `Catalog ${i + 1}`,
      cwd: join(tempHome, `cwd-${i % 12}`),
      updatedAt: new Date(Date.UTC(2026, 10, 21, 12, 0, 0) - i * 60_000).toISOString(),
    }));

    const { manager, peers, capableBroadcasts, handlers } = createSessionManagerHarness({
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                sessionCapabilities: { resume: {}, list: {} },
              },
            },
          });
        } else if (msg.method === "session/list") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessions: catalog } });
        } else if (msg.method === "session/new") {
          const sid = `created-${++sessionSeq}`;
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: sid } });
        } else if (msg.method === "session/load" || msg.method === "session/resume") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
        } else if (msg.method === "session/prompt") {
          promptMethods.push(String((msg.params as any).sessionId));
          const text = String(((msg.params as any).prompt[0] as any).text);
          if (text === "hold") {
            holdPromptResolve = () => {
              peer.emit({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: (msg.params as any).sessionId,
                  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "held-done" } },
                },
              });
              peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
            };
            return;
          }
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        }
      },
    });
    cleanups.push(() => manager.shutdown());

    const ws = makeCapableWs();
    clients.add(ws);
    handlers.onClientHello?.(ws);
    expect(ws.frames[0]!.type).toBe("session_list");
    expect(ws.frames[0]!.defaultCwd).toBe(tempHome);

    // 1. startTurn auto-create broadcasts session_switched + session_list
    await handlers.onInbound({ text: "auto-create", meta: {} });
    await waitFor(
      () =>
        capableBroadcasts.some((b) => b.frame.type === "session_switched") &&
        !manager.getStateSnapshot().turnBusy,
    );
    expect(manager.getStateSnapshot().activeSessionId).toBe("created-1");
    expect(promptMethods.length).toBe(1);

    // 2. session_list_request runs without triggering session/prompt, caps at 50 sessions & 8 recentCwds
    ws.frames.length = 0;
    await handlers.onControlFrame?.(ws, {
      type: "session_list_request",
      requestId: "list-req-1",
    });
    const listFrame = ws.frames.find((f) => f.type === "session_list")!;
    expect(listFrame.requestId).toBe("list-req-1");
    const sessionsArr = listFrame.sessions as Array<{ sessionId: string }>;
    const recentCwds = listFrame.recentCwds as string[];
    expect(sessionsArr.length).toBe(50);
    expect(recentCwds.length).toBe(8);
    expect(new Set(recentCwds).size).toBe(8);
    expect(promptMethods.length).toBe(1);

    // Switch to oldest catalog session (cat-60, outside top 50), then refresh session_list_request -> still <= 50 AND contains cat-60!
    await handlers.onControlFrame?.(ws, {
      type: "session_resume",
      sessionId: "cat-60",
      includeRecentTurns: false,
      requestId: "res-oldest",
    });
    expect(manager.getStateSnapshot().activeSessionId).toBe("cat-60");
    ws.frames.length = 0;
    await handlers.onControlFrame?.(ws, {
      type: "session_list_request",
      requestId: "list-req-2",
    });
    const listWithOldest = ws.frames.find((f) => f.type === "session_list")!;
    const sessionsWithOldest = listWithOldest.sessions as Array<{ sessionId: string }>;
    expect(sessionsWithOldest.length).toBe(50);
    expect(sessionsWithOldest.some((s) => s.sessionId === "cat-60")).toBe(true);

    // 3. session_new invalid_cwd checks (non-existent, regular file, unreadable chmod 000)
    ws.frames.length = 0;
    await handlers.onControlFrame?.(ws, {
      type: "session_new",
      cwd: join(tempHome, "missing-dir"),
      requestId: "bad-1",
    });
    expect(ws.frames.at(-1)).toMatchObject({
      type: "session_error",
      action: "session_new",
      code: "invalid_cwd",
      requestId: "bad-1",
    });
    expect(manager.getStateSnapshot().activeSessionId).toBe("cat-60");

    await handlers.onControlFrame?.(ws, {
      type: "session_new",
      cwd: regularFile,
      requestId: "bad-2",
    });
    expect(ws.frames.at(-1)).toMatchObject({
      type: "session_error",
      action: "session_new",
      code: "invalid_cwd",
      requestId: "bad-2",
    });

    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      chmodSync(lockedDir, 0o000);
      try {
        await handlers.onControlFrame?.(ws, {
          type: "session_new",
          cwd: lockedDir,
          requestId: "bad-3",
        });
        expect(ws.frames.at(-1)).toMatchObject({
          type: "session_error",
          action: "session_new",
          code: "invalid_cwd",
          requestId: "bad-3",
        });
      } finally {
        chmodSync(lockedDir, 0o755);
      }
    }

    // 4. Valid ~/proj-a via WS session_new -> updates MRU recentCwds & broadcasts
    capableBroadcasts.length = 0;
    await handlers.onControlFrame?.(ws, {
      type: "session_new",
      cwd: "~/proj-a",
      requestId: "new-a",
    });
    const newSwitched = capableBroadcasts.find((b) => b.frame.type === "session_switched")!;
    expect(newSwitched.frame).toMatchObject({
      type: "session_switched",
      sessionId: "created-2",
      cwd: dirA,
      requestId: "new-a",
    });
    const newList = capableBroadcasts.find((b) => b.frame.type === "session_list")!;
    expect((newList.frame.recentCwds as string[])[0]).toBe(dirA);
    expect((newList.frame.recentCwds as string[]).length).toBeLessThanOrEqual(8);

    // 5. Slash /new and /resume broadcast session_switched + session_list
    capableBroadcasts.length = 0;
    await handlers.onInbound({ text: `/new ${dirB}`, meta: {} });
    expect(
      capableBroadcasts.some(
        (b) => b.frame.type === "session_switched" && b.frame.sessionId === "created-3" && b.frame.cwd === dirB,
      ),
    ).toBe(true);

    capableBroadcasts.length = 0;
    await handlers.onInbound({ text: "/sessions", meta: {} });
    await handlers.onInbound({ text: "/resume 1", meta: {} });
    expect(
      capableBroadcasts.some(
        (b) => b.frame.type === "session_switched" && b.frame.sessionId === "cat-1",
      ),
    ).toBe(true);

    // 6. turn_busy blocks session_new and session_resume while session_list_request still succeeds cleanly
    await handlers.onInbound({ text: "hold", meta: {} });
    await waitFor(() => typeof holdPromptResolve === "function");
    ws.frames.length = 0;
    await handlers.onControlFrame?.(ws, { type: "session_new", requestId: "busy-new" });
    expect(ws.frames.at(-1)).toMatchObject({
      type: "session_error",
      action: "session_new",
      code: "turn_busy",
      requestId: "busy-new",
    });
    await handlers.onControlFrame?.(ws, {
      type: "session_resume",
      sessionId: "cat-2",
      requestId: "busy-res",
    });
    expect(ws.frames.at(-1)).toMatchObject({
      type: "session_error",
      action: "session_resume",
      code: "turn_busy",
      requestId: "busy-res",
    });
    await handlers.onControlFrame?.(ws, {
      type: "session_list_request",
      requestId: "busy-list",
    });
    expect(ws.frames.at(-1)?.type).toBe("session_list");
    expect(ws.frames.at(-1)?.requestId).toBe("busy-list");

    holdPromptResolve!();
    await waitFor(() => !manager.getStateSnapshot().turnBusy);

    // 7. handleHarnessExit crash clears activeSessionId=null and broadcasts session_switched + session_list
    capableBroadcasts.length = 0;
    peers[0]!.crash(137);
    await waitFor(() =>
      capableBroadcasts.some(
        (b) => b.frame.type === "session_switched" && b.frame.sessionId === null,
      ),
    );
    expect(
      capableBroadcasts.some(
        (b) => b.frame.type === "session_list" && b.frame.activeSessionId === null,
      ),
    ).toBe(true);
    expect(promptMethods.length).toBe(2);
  });

  it("AV4: non-Hermes session_resume(includeRecentTurns) captures sliding window <=6 turns / <=8KB / <=1200 chars without leaking to outOfTurnChunks", async () => {
    const { manager, replies, capableBroadcasts, handlers } =
      createSessionManagerHarness({
        harness: "codex",
        onOutbound: (msg, peer) => {
          if (msg.method === "initialize") {
            peer.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {
                  loadSession: true,
                  sessionCapabilities: { resume: {}, list: {} },
                },
              },
            });
          } else if (msg.method === "session/load") {
            const sid = String((msg.params as any).sessionId);
            if (sid === "cli-10-turns") {
              // Emit 10 turns (5 user + 5 assistant) with multi-chunk + >1200 chars on turn 10
              for (let i = 1; i <= 5; i++) {
                peer.emit({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: sid,
                    update: {
                      sessionUpdate: "user_message_chunk",
                      content: { type: "text", text: `U${i}-` },
                    },
                  },
                });
                peer.emit({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: sid,
                    update: {
                      sessionUpdate: "user_message_chunk",
                      content: { type: "text", text: "msg" },
                    },
                  },
                });
                peer.emit({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: sid,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: {
                        type: "text",
                        text: i === 5 ? `A5:${"x".repeat(1600)}` : `A${i}-reply`,
                      },
                    },
                  },
                });
              }
            } else if (sid === "cli-utf8-heavy") {
              // 6 turns of 1200 3-byte UTF-8 chars (~3600 bytes each) -> must evict to <= 8 KB UTF-8!
              for (let i = 1; i <= 6; i++) {
                peer.emit({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: sid,
                    update: {
                      sessionUpdate: i % 2 === 1 ? "user_message_chunk" : "agent_message_chunk",
                      content: { type: "text", text: "あ".repeat(1200) },
                    },
                  },
                });
              }
            }
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
          }
        },
      });
    cleanups.push(() => manager.shutdown());

    const ws = makeCapableWs();
    clients.add(ws);

    await handlers.onControlFrame?.(ws, {
      type: "session_resume",
      sessionId: "cli-10-turns",
      includeRecentTurns: true,
      requestId: "r-tail-1",
    });

    const sw1 = capableBroadcasts.find(
      (b) => b.frame.type === "session_switched" && b.frame.sessionId === "cli-10-turns",
    )!;
    const turns1 = sw1.frame.recentTurns as RecentTurnSummary[];
    expect(turns1.length).toBe(6);
    expect(turns1[0]).toEqual({ role: "user", text: "U3-msg" });
    expect(turns1[1]).toEqual({ role: "assistant", text: "A3-reply" });
    expect(turns1[4]).toEqual({ role: "user", text: "U5-msg" });
    expect(turns1[5]!.role).toBe("assistant");
    expect(turns1[5]!.text.length).toBe(1200);
    expect(Buffer.byteLength(JSON.stringify(turns1), "utf8")).toBeLessThanOrEqual(8192);

    // Multi-byte UTF-8 test
    capableBroadcasts.length = 0;
    await handlers.onControlFrame?.(ws, {
      type: "session_resume",
      sessionId: "cli-utf8-heavy",
      includeRecentTurns: true,
      requestId: "r-tail-2",
    });
    const sw2 = capableBroadcasts.find(
      (b) => b.frame.type === "session_switched" && b.frame.sessionId === "cli-utf8-heavy",
    )!;
    const turns2 = sw2.frame.recentTurns as RecentTurnSummary[];
    expect(turns2.length).toBeLessThanOrEqual(2);
    expect(Buffer.byteLength(JSON.stringify(turns2), "utf8")).toBeLessThanOrEqual(8192);

    // Wait past outOfTurnQuietMs to confirm zero replay chunks leaked as standalone replies
    await new Promise((r) => setTimeout(r, 70));
    expect(replies.length).toBe(0);
    expect(manager.getStateSnapshot().outOfTurnBufferedLength).toBe(0);
  });

  it("AV4: pre-timeout session/load rejection clears loadingSessionIds before falling back to session/resume with recentTurns: []", async () => {
    const rpcMethods: string[] = [];
    let resumeSupported = true;
    let loadingSetAtResumeStart = true;

    const { manager, capableBroadcasts, handlers } = createSessionManagerHarness({
      harness: "agy",
      onOutbound: (msg, peer) => {
        if (typeof msg.method === "string") rpcMethods.push(msg.method);
        if (msg.method === "initialize") {
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                sessionCapabilities: resumeSupported ? { resume: {}, list: {} } : { list: {} },
              },
            },
          });
        } else if (msg.method === "session/load") {
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32001, message: "session/load unsupported for this item" },
          });
        } else if (msg.method === "session/resume") {
          loadingSetAtResumeStart = (manager as any).loadingSessionIds.has(
            (msg.params as any).sessionId,
          );
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
        }
      },
    });
    cleanups.push(() => manager.shutdown());

    const ws = makeCapableWs();
    clients.add(ws);

    await handlers.onControlFrame?.(ws, {
      type: "session_resume",
      sessionId: "fallback-s1",
      includeRecentTurns: true,
      requestId: "r-fb-1",
    });

    expect(rpcMethods).toEqual(["initialize", "session/load", "session/resume"]);
    expect(loadingSetAtResumeStart).toBe(true);
    expect((manager as any).loadingSessionIds.has("fallback-s1")).toBe(false);
    expect((manager as any).inFlightSessionLoads.has("fallback-s1")).toBe(false);

    const sw = capableBroadcasts.find((b) => b.frame.type === "session_switched")!;
    expect(sw.frame.sessionId).toBe("fallback-s1");
    expect(sw.frame.recentTurns).toEqual([]);

    // When resume is unsupported and session/load fails -> load_failed error
    const noResume = createSessionManagerHarness({
      harness: "agy",
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
          });
        } else if (msg.method === "session/load") {
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: "load broken" },
          });
        }
      },
    });
    cleanups.push(() => noResume.manager.shutdown());
    const ws2 = makeCapableWs();
    clients.add(ws2);
    await noResume.handlers.onControlFrame?.(ws2, {
      type: "session_resume",
      sessionId: "nores-1",
      includeRecentTurns: true,
      requestId: "r-nores",
    });
    expect(ws2.frames.at(-1)).toMatchObject({
      type: "session_error",
      action: "session_resume",
      code: "load_failed",
      requestId: "r-nores",
    });
  });

  it("AV4: slow-replay session/load exceeding timeout emits load_timeout, keeps prior activeSessionId, drops late chunks without leaking, blocks concurrent resume, and keeps subsequent turn clean", async () => {
    let releaseSlowLoad!: () => void;
    let slowLoadSessionId = "";
    const rpcLog: Array<{ method: string; sessionId?: string }> = [];

    const { manager, peers, replies, capableBroadcasts, handlers } =
      createSessionManagerHarness({
        harness: "agy",
        sessionLoadTimeoutMs: 50,
        onOutbound: (msg, peer) => {
          if (typeof msg.method === "string") {
            rpcLog.push({
              method: msg.method,
              sessionId: (msg.params as any)?.sessionId,
            });
          }
          if (msg.method === "initialize") {
            peer.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {
                  loadSession: true,
                  sessionCapabilities: { resume: {}, list: {} },
                },
              },
            });
          } else if (msg.method === "session/new") {
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-prior" } });
          } else if (msg.method === "session/load") {
            slowLoadSessionId = String((msg.params as any).sessionId);
            // Partial chunk before timeout
            peer.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: slowLoadSessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "EARLY_CHUNK " },
                },
              },
            });
            releaseSlowLoad = () => {
              // Late chunks emitted after timeout while loadPromise still settling
              peer.emit({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: slowLoadSessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "LATE_REPLAY_LEAK" },
                  },
                },
              });
              peer.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
            };
          } else if (msg.method === "session/prompt") {
            const sid = String((msg.params as any).sessionId);
            const text = String(((msg.params as any).prompt[0] as any).text);
            peer.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: `clean:${text}` },
                },
              },
            });
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          }
        },
      });
    cleanups.push(() => manager.shutdown());

    const ws = makeCapableWs();
    clients.add(ws);

    await handlers.onControlFrame?.(ws, {
      type: "session_new",
      requestId: "r-prior",
    });
    expect(manager.getStateSnapshot().activeSessionId).toBe("s-prior");

    capableBroadcasts.length = 0;
    ws.frames.length = 0;

    await handlers.onControlFrame?.(ws, {
      type: "session_resume",
      sessionId: "s-slow",
      includeRecentTurns: true,
      requestId: "r-slow-1",
    });

    // Timeout fired: session_error(load_timeout), prior activeSessionId intact, sessionOpInFlight released, 0 concurrent session/resume
    expect(ws.frames.at(-1)).toEqual({
      type: "session_error",
      action: "session_resume",
      code: "load_timeout",
      message: "Timed out loading session 's-slow' after 50ms",
      requestId: "r-slow-1",
    });
    expect(manager.getStateSnapshot().activeSessionId).toBe("s-prior");
    expect((manager as any).sessionOpInFlight).toBe(false);
    expect((manager as any).loadingSessionIds.has("s-slow")).toBe(true);
    expect((manager as any).inFlightSessionLoads.has("s-slow")).toBe(true);
    expect(rpcLog.some((r) => r.method === "session/resume")).toBe(false);
    expect(capableBroadcasts.length).toBe(0);

    // Repeated session_resume for s-slow while still pending fails immediately with load_timeout (no concurrent load/resume)
    const loadCountBefore = rpcLog.filter((r) => r.method === "session/load").length;
    await handlers.onControlFrame?.(ws, {
      type: "session_resume",
      sessionId: "s-slow",
      includeRecentTurns: true,
      requestId: "r-slow-2",
    });
    expect(ws.frames.at(-1)).toMatchObject({
      type: "session_error",
      action: "session_resume",
      code: "load_timeout",
      requestId: "r-slow-2",
    });
    expect(rpcLog.filter((r) => r.method === "session/load").length).toBe(loadCountBefore);
    expect(rpcLog.some((r) => r.method === "session/resume")).toBe(false);

    // Release slow load (emits LATE_REPLAY_LEAK then resolves) -> must NOT leak into outOfTurnChunks
    releaseSlowLoad();
    await waitFor(() => !(manager as any).inFlightSessionLoads.has("s-slow"));
    await new Promise((r) => setTimeout(r, 60));
    expect(replies.some((r) => r.text.includes("LATE_REPLAY_LEAK"))).toBe(false);
    expect(replies.some((r) => r.text.includes("EARLY_CHUNK"))).toBe(false);
    expect(manager.getStateSnapshot().outOfTurnBufferedLength).toBe(0);

    // Subsequent turn on s-prior produces clean text
    await handlers.onInbound({ text: "after-timeout", meta: {} });
    await waitFor(() => replies.some((r) => r.text === "clean:after-timeout"));
    expect(replies.at(-1)?.acpSessionId).toBe("s-prior");

    // Also verify startTurn awaits inFlightSessionLoads.get(sessionId) before calling session/prompt
    let releaseActiveLoad!: () => void;
    let promptIssuedBeforeLoadFinished = false;
    let loadPending = false;
    const waitHarness = createSessionManagerHarness({
      harness: "agy",
      sessionLoadTimeoutMs: 30,
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
            },
          });
        } else if (msg.method === "session/load") {
          loadPending = true;
          releaseActiveLoad = () => {
            loadPending = false;
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
          };
        } else if (msg.method === "session/prompt") {
          if (loadPending) promptIssuedBeforeLoadFinished = true;
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: (msg.params as any).sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "awaited-ok" } },
            },
          });
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        }
      },
    });
    cleanups.push(() => waitHarness.manager.shutdown());
    const wsWait = makeCapableWs();
    clients.add(wsWait);
    // Simulate activeSessionId already matching the timed-out session
    (waitHarness.manager as any).activeSessionId = "s-await";
    await waitHarness.handlers.onControlFrame?.(wsWait, {
      type: "session_resume",
      sessionId: "s-await",
      includeRecentTurns: true,
    });
    expect((waitHarness.manager as any).inFlightSessionLoads.has("s-await")).toBe(true);
    const turnP = waitHarness.handlers.onInbound({ text: "hello", meta: {} });
    await new Promise((r) => setTimeout(r, 30));
    expect(waitHarness.peers[0]!.sent.some((m) => m.method === "session/prompt")).toBe(false);
    releaseActiveLoad();
    await turnP;
    await waitFor(() => waitHarness.replies.some((r) => r.text === "awaited-ok"));
    expect(promptIssuedBeforeLoadFinished).toBe(false);
  });

  it("AV4: Hermes keeps session/resume replay capture under loadingSessionIds", async () => {
    const rpcMethods: string[] = [];
    const { manager, replies, capableBroadcasts, handlers } = createSessionManagerHarness({
      harness: "hermes",
      onOutbound: (msg, peer) => {
        if (typeof msg.method === "string") rpcMethods.push(msg.method);
        if (msg.method === "initialize") {
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                sessionCapabilities: { resume: {}, list: {} },
              },
            },
          });
        } else if (msg.method === "session/resume") {
          const sid = String((msg.params as any).sessionId);
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: "hermes user" },
              },
            },
          });
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "hermes replay" },
              },
            },
          });
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
        }
      },
    });
    cleanups.push(() => manager.shutdown());

    const ws = makeCapableWs();
    clients.add(ws);
    await handlers.onControlFrame?.(ws, {
      type: "session_resume",
      sessionId: "hermes-1",
      includeRecentTurns: true,
      requestId: "r-hermes",
    });

    expect(rpcMethods).toEqual(["initialize", "session/resume"]);
    const sw = capableBroadcasts.find((b) => b.frame.type === "session_switched")!;
    expect(sw.frame.recentTurns).toEqual([
      { role: "user", text: "hermes user" },
      { role: "assistant", text: "hermes replay" },
    ]);
    await new Promise((r) => setTimeout(r, 60));
    expect(replies.length).toBe(0);
  });

  it("AV4+AV6 end-to-end with startDaemon: real WS session_resume + session_new + acpSessionId on replies", async () => {
    const dir = tempHome;
    process.env.HITL_CHANNEL_API_KEY = "p3a-sess-key";
    const fakeAgent = join(import.meta.dir, "fixtures", "fake_acp_agent.ts");
    const daemon = await startDaemon({
      harness: "agy",
      port: 0,
      cwd: dir,
      enableMdns: false,
      enableDesktopNotifications: false,
      transportFactory: (_c, _a, opts) =>
        spawnAcpTransport(process.execPath, ["run", fakeAgent], {
          cwd: opts?.cwd,
        }),
    });
    cleanups.push(() => daemon.shutdown());

    const ws = new WebSocket(
      `ws://127.0.0.1:${daemon.port}/ws?api_key=p3a-sess-key`,
    );
    cleanups.push(() => ws.close());
    const frames: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as Record<string, unknown>;
      frames.push(f);
      if (f.type === "reply" && f.id) ws.send(JSON.stringify({ type: "ack", id: f.id }));
    };

    ws.send(
      JSON.stringify({
        type: "client_hello",
        proto: 3,
        features: ["sessions", "choices_settled"],
      }),
    );
    await waitFor(() => frames.some((f) => f.type === "session_list"));

    ws.send(JSON.stringify({ type: "session_new", requestId: "e2e-new" }));
    await waitFor(() =>
      frames.some((f) => f.type === "session_switched" && f.requestId === "e2e-new"),
    );
    const swNew = frames.find(
      (f) => f.type === "session_switched" && f.requestId === "e2e-new",
    )!;
    expect(swNew.sessionId).toBe("fake-sess-1");

    await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: {
        authorization: "Bearer p3a-sess-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "hi daemon" }),
    });
    await waitFor(() =>
      frames.some((f) => f.type === "reply" && f.text === "echo:hi daemon"),
    );
    const reply = frames.find((f) => f.type === "reply" && f.text === "echo:hi daemon")!;
    expect(reply.acpSessionId).toBe("fake-sess-1");

    // Resume fake-sess-1 with includeRecentTurns -> fake_acp_agent emits REPLAYED_ON_LOAD
    ws.send(
      JSON.stringify({
        type: "session_resume",
        sessionId: "fake-sess-1",
        includeRecentTurns: true,
        requestId: "e2e-res",
      }),
    );
    await waitFor(() =>
      frames.some((f) => f.type === "session_switched" && f.requestId === "e2e-res"),
    );
    const swRes = frames.find(
      (f) => f.type === "session_switched" && f.requestId === "e2e-res",
    )!;
    expect(swRes.recentTurns).toEqual([
      { role: "assistant", text: "REPLAYED_ON_LOAD " },
    ]);
  });
});
