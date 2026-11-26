import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpTransport } from "../acp_client.js";
import {
  AcpSessionManager,
  isSessionNotFoundError,
} from "../acp_session_manager.js";
import { clients, replyBuffer, sendControlToClient } from "../http_bridge.js";
import type { HitlWebSocket } from "../types.js";

class FakePeerTransport implements AcpTransport {
  readonly pid = 88999;
  sent: Array<Record<string, unknown>> = [];
  private lineCbs: Array<(line: string) => void> = [];
  private closeCbs: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  closed = false;

  constructor(
    private readonly onOutbound: (
      msg: Record<string, unknown>,
      peer: FakePeerTransport,
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
    const line = JSON.stringify(obj);
    for (const cb of this.lineCbs) cb(line);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb(0, null);
  }
}

function makeCapableWs(
  features = ["sessions", "choices_settled"],
): HitlWebSocket & { frames: Array<Record<string, unknown>> } {
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

describe("agy phantom session filtering & not-found guards", () => {
  let tempRoot: string;
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "hitl-agy-phantom-"));
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
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function createHarness(opts: {
    harness?: "agy" | "codex" | "hermes";
    agyConversationsDir?: string | null;
    onOutbound: (
      msg: Record<string, unknown>,
      peer: FakePeerTransport,
    ) => void;
  }) {
    const replies: Array<{ text: string; acpSessionId?: string | null }> = [];
    const capableBroadcasts: Array<{
      feature: string;
      frame: Record<string, unknown>;
    }> = [];

    const manager = new AcpSessionManager({
      harness: opts.harness ?? "agy",
      defaultCwd: tempRoot,
      mcpUrl: "http://127.0.0.1:45557/mcp",
      mcpToken: "tok",
      instanceId: "inst-agy-phantom",
      agyConversationsDir: opts.agyConversationsDir,
      transportFactory: () => new FakePeerTransport(opts.onOutbound),
      broadcastReplyFn: (text, _messageId, _agentId, _atts, replyOpts) => {
        replies.push({ text, acpSessionId: replyOpts?.acpSessionId ?? null });
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
      sendControlToClientFn: (ws, frame, requiredFeature) =>
        sendControlToClient(ws, frame, requiredFeature),
      unicastFrameFn: () => ({ delivered: true, targetDevice: "dev-1" }),
      auditFn: async () => {},
    });

    cleanups.push(() => manager.shutdown());
    return {
      manager,
      replies,
      capableBroadcasts,
      handlers: manager.getInboundHandlers(),
    };
  }

  it("isSessionNotFoundError matches missing trajectory/session errors but not unsupported errors", () => {
    expect(
      isSessionNotFoundError(
        new Error(
          "ACP RPC error -32603: Failed to send user message: not_found: trajectory not found: abc: file does not exist",
        ),
      ),
    ).toBe(true);
    expect(isSessionNotFoundError(new Error("Trajectory does not exist"))).toBe(
      true,
    );
    expect(isSessionNotFoundError(new Error("ENOENT: no such file"))).toBe(
      true,
    );
    expect(isSessionNotFoundError("session not found")).toBe(true);
    expect(
      isSessionNotFoundError(new Error("session/load unsupported for this item")),
    ).toBe(false);
    expect(
      isSessionNotFoundError(new Error("ACP RPC error -32601: Method not found: session/load")),
    ).toBe(false);
  });

  it("filters IDE-only sessions & cwds from session_list_request and /sessions while keeping .db, .pb, active, and sessionNew sessions", async () => {
    const convDir = join(tempRoot, "agy-convs");
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(convDir, "local-db-1.db"), "");
    writeFileSync(join(convDir, "local-pb-1.pb"), "");
    // SQLite sidecar files should not produce phantom IDs ending in .db-wal / .db-shm
    writeFileSync(join(convDir, "ide-wal-only.db-wal"), "");
    writeFileSync(join(convDir, "ide-wal-only.db-shm"), "");

    const localDbCwd = join(tempRoot, "proj-local-db");
    const localPbCwd = join(tempRoot, "proj-local-pb");
    const ideOnlyCwd = join(tempRoot, "proj-ide-ghost");
    mkdirSync(localDbCwd, { recursive: true });
    mkdirSync(localPbCwd, { recursive: true });
    mkdirSync(ideOnlyCwd, { recursive: true });

    let createdCounter = 0;
    const listedSessions = [
      {
        sessionId: "ide-ghost-1",
        title: "IDE Ghost",
        cwd: ideOnlyCwd,
        updatedAt: "2026-11-26T20:00:00Z",
      },
      {
        sessionId: "ide-wal-only",
        title: "WAL Noise",
        cwd: ideOnlyCwd,
        updatedAt: "2026-11-26T19:50:00Z",
      },
      {
        sessionId: "local-db-1",
        title: "Local DB",
        cwd: localDbCwd,
        updatedAt: "2026-11-26T19:40:00Z",
      },
      {
        sessionId: "local-pb-1",
        title: "Local PB",
        cwd: localPbCwd,
        updatedAt: "2026-11-26T19:30:00Z",
      },
      {
        sessionId: "created-in-mem",
        title: "Created In Memory",
        cwd: tempRoot,
        updatedAt: "2026-11-26T19:20:00Z",
      },
    ];

    const { manager, replies, handlers } = createHarness({
      agyConversationsDir: convDir,
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
        } else if (msg.method === "session/new") {
          createdCounter++;
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              sessionId: createdCounter === 1 ? "created-in-mem" : `created-${createdCounter}`,
            },
          });
        } else if (msg.method === "session/list") {
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            result: { sessions: listedSessions },
          });
        } else if (msg.method === "session/resume" || msg.method === "session/load") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
        }
      },
    });

    const ws = makeCapableWs();
    clients.add(ws);

    // Create a session via session_new (not yet written as .db/.pb in convDir)
    await handlers.onControlFrame?.(ws, {
      type: "session_new",
      requestId: "new-1",
    });
    expect(manager.getStateSnapshot().activeSessionId).toBe("created-in-mem");

    // Switch activeSessionId to local-db-1, verifying created-in-mem is still preserved by createdSessionIds
    await handlers.onControlFrame?.(ws, {
      type: "session_resume",
      sessionId: "local-db-1",
      includeRecentTurns: false,
      requestId: "res-local",
    });
    expect(manager.getStateSnapshot().activeSessionId).toBe("local-db-1");

    ws.frames.length = 0;
    await handlers.onControlFrame?.(ws, {
      type: "session_list_request",
      requestId: "list-1",
    });

    const listFrame = ws.frames.find((f) => f.type === "session_list")!;
    const ids = (listFrame.sessions as Array<{ sessionId: string }>).map(
      (s) => s.sessionId,
    );
    expect(ids).toEqual(["local-db-1", "local-pb-1", "created-in-mem"]);
    expect(ids).not.toContain("ide-ghost-1");
    expect(ids).not.toContain("ide-wal-only");

    const recentCwds = listFrame.recentCwds as string[];
    expect(recentCwds).toContain(localDbCwd);
    expect(recentCwds).toContain(localPbCwd);
    expect(recentCwds).not.toContain(ideOnlyCwd);

    // /sessions slash command also filters out IDE-only sessions
    replies.length = 0;
    await handlers.onInbound({ text: "/sessions", meta: {} });
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain("Local DB");
    expect(replies[0]!.text).toContain("Local PB");
    expect(replies[0]!.text).toContain("Created In Memory");
    expect(replies[0]!.text).not.toContain("IDE Ghost");
    expect(replies[0]!.text).not.toContain("WAL Noise");
  });

  it("keeps sessions created via /new and startTurn auto-create even when not yet written to agyConversationsDir", async () => {
    const convDir = join(tempRoot, "agy-convs-created");
    mkdirSync(convDir, { recursive: true });
    let seq = 0;

    const { manager, handlers } = createHarness({
      agyConversationsDir: convDir,
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
        } else if (msg.method === "session/new") {
          seq++;
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              sessionId: seq === 1 ? "auto-created-1" : "slash-new-2",
            },
          });
        } else if (msg.method === "session/prompt") {
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            result: { stopReason: "end_turn" },
          });
        } else if (msg.method === "session/list") {
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              sessions: [
                { sessionId: "auto-created-1", title: "Auto Created" },
                { sessionId: "slash-new-2", title: "Slash New" },
                { sessionId: "ide-ghost-x", title: "IDE Ghost X" },
              ],
            },
          });
        }
      },
    });

    // 1. startTurn auto-create
    await handlers.onInbound({ text: "hello", meta: {} });
    const deadline = Date.now() + 2000;
    while (manager.getStateSnapshot().turnBusy && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(manager.getStateSnapshot().activeSessionId).toBe("auto-created-1");

    // 2. /new slash command (switches activeSessionId away from auto-created-1)
    await handlers.onInbound({ text: `/new ${tempRoot}`, meta: {} });
    expect(manager.getStateSnapshot().activeSessionId).toBe("slash-new-2");

    // 3. session_list_request keeps both auto-created-1 and slash-new-2 while excluding ide-ghost-x
    const ws = makeCapableWs();
    clients.add(ws);
    await handlers.onControlFrame?.(ws, {
      type: "session_list_request",
      requestId: "list-created",
    });
    const listFrame = ws.frames.find((f) => f.type === "session_list")!;
    const ids = (listFrame.sessions as Array<{ sessionId: string }>).map(
      (s) => s.sessionId,
    );
    expect(ids).toEqual(["auto-created-1", "slash-new-2"]);
  });

  it("fails open when agyConversationsDir does not exist (ENOENT)", async () => {
    const missingDir = join(tempRoot, "does-not-exist");
    const { handlers } = createHarness({
      agyConversationsDir: missingDir,
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
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              sessions: [
                { sessionId: "sess-a", title: "Session A" },
                { sessionId: "sess-b", title: "Session B" },
              ],
            },
          });
        }
      },
    });

    const ws = makeCapableWs();
    clients.add(ws);
    await handlers.onControlFrame?.(ws, {
      type: "session_list_request",
      requestId: "enoent-list",
    });

    const listFrame = ws.frames.find((f) => f.type === "session_list")!;
    const ids = (listFrame.sessions as Array<{ sessionId: string }>).map(
      (s) => s.sessionId,
    );
    expect(ids).toEqual(["sess-a", "sess-b"]);
  });

  it("never filters sessions via agyConversationsDir for non-agy harnesses (codex, hermes)", async () => {
    const convDir = join(tempRoot, "agy-convs-ignored");
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(convDir, "only-agy.db"), "");

    for (const harness of ["codex", "hermes"] as const) {
      const { handlers } = createHarness({
        harness,
        agyConversationsDir: convDir,
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
            peer.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                sessions: [
                  { sessionId: `${harness}-s1`, title: "Foreign Session" },
                ],
              },
            });
          }
        },
      });

      const ws = makeCapableWs();
      clients.add(ws);
      await handlers.onControlFrame?.(ws, {
        type: "session_list_request",
        requestId: `list-${harness}`,
      });

      const listFrame = ws.frames.find((f) => f.type === "session_list")!;
      const ids = (listFrame.sessions as Array<{ sessionId: string }>).map(
        (s) => s.sessionId,
      );
      expect(ids).toEqual([`${harness}-s1`]);
      clients.delete(ws);
    }
  });

  it("rejects session_resume (includeRecentTurns: true) with load_failed and skips session/resume when session/load returns not_found", async () => {
    const rpcMethods: string[] = [];

    const { manager, handlers } = createHarness({
      agyConversationsDir: null,
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
        } else if (msg.method === "session/new") {
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            result: { sessionId: "prior-active" },
          });
        } else if (msg.method === "session/load") {
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32603,
              message:
                "not_found: failed to ensure trajectory loaded: trajectory ghost-1 not found in any store: file does not exist",
            },
          });
        } else if (msg.method === "session/resume") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
        }
      },
    });

    const ws = makeCapableWs();
    clients.add(ws);
    await handlers.onControlFrame?.(ws, {
      type: "session_new",
      requestId: "setup-new",
    });
    expect(manager.getStateSnapshot().activeSessionId).toBe("prior-active");

    ws.frames.length = 0;
    await handlers.onControlFrame?.(ws, {
      type: "session_resume",
      sessionId: "ghost-1",
      includeRecentTurns: true,
      requestId: "res-ghost-load",
    });

    expect(rpcMethods).toEqual(["initialize", "session/new", "session/load"]);
    expect(rpcMethods).not.toContain("session/resume");
    expect(manager.getStateSnapshot().activeSessionId).toBe("prior-active");
    expect(ws.frames.at(-1)).toMatchObject({
      type: "session_error",
      action: "session_resume",
      code: "load_failed",
      requestId: "res-ghost-load",
    });
  });

  it("rejects session_resume (includeRecentTurns: false) and /resume <ide-session-id> when session is missing from local agy store", async () => {
    const convDir = join(tempRoot, "agy-convs-resume");
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(convDir, "valid-local.db"), "");

    const rpcMethods: string[] = [];
    const { manager, replies, handlers } = createHarness({
      agyConversationsDir: convDir,
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
        } else if (msg.method === "session/list") {
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              sessions: [
                { sessionId: "valid-local", title: "Valid Local" },
                { sessionId: "ide-only-ghost", title: "IDE Ghost" },
              ],
            },
          });
        } else if (msg.method === "session/resume" || msg.method === "session/load") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
        }
      },
    });

    const ws = makeCapableWs();
    clients.add(ws);

    // Establish valid prior active session
    await handlers.onControlFrame?.(ws, {
      type: "session_resume",
      sessionId: "valid-local",
      includeRecentTurns: false,
      requestId: "res-valid",
    });
    expect(manager.getStateSnapshot().activeSessionId).toBe("valid-local");

    // Attempt WS session_resume (includeRecentTurns: false) on IDE-only ghost session
    ws.frames.length = 0;
    rpcMethods.length = 0;
    await handlers.onControlFrame?.(ws, {
      type: "session_resume",
      sessionId: "ide-only-ghost",
      includeRecentTurns: false,
      requestId: "res-ghost-fast",
    });
    expect(rpcMethods).toEqual([]);
    expect(manager.getStateSnapshot().activeSessionId).toBe("valid-local");
    expect(ws.frames.at(-1)).toMatchObject({
      type: "session_error",
      action: "session_resume",
      code: "load_failed",
      requestId: "res-ghost-fast",
    });

    // Attempt /resume <ide-session-id> slash command
    replies.length = 0;
    rpcMethods.length = 0;
    const slashResult = await handlers.onInbound({
      text: "/resume ide-only-ghost",
      meta: {},
    });
    expect(slashResult).toEqual({ acpSessionId: "valid-local" });
    expect(manager.getStateSnapshot().activeSessionId).toBe("valid-local");
    expect(rpcMethods).not.toContain("session/resume");
    expect(rpcMethods).not.toContain("session/load");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain("Failed to resume session");
    expect(replies[0]!.text).toContain("ide-only-ghost");
  });
});
