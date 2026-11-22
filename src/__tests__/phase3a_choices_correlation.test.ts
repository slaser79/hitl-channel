import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpTransport } from "../acp_client.js";
import { AcpSessionManager } from "../acp_session_manager.js";
import {
  clients,
  normalizeInboundPayload,
  replyBuffer,
  startHttpBridge,
  type InboundMessage,
} from "../http_bridge.js";
import type { HitlWebSocket } from "../types.js";

class FakePeerTransport implements AcpTransport {
  readonly pid = 77777;
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

describe("SPEC-HITL-APP-10827 Milestone 3a AV7: choices_id / option_id HTTP correlation, queue guard, choices_settled", () => {
  let prevHome: string | undefined;
  let prevApiKey: string | undefined;
  let tempHome: string;
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevApiKey = process.env.HITL_CHANNEL_API_KEY;
    tempHome = mkdtempSync(join(tmpdir(), "hitl-p3a-choices-"));
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

  it("AV7: normalizeInboundPayload extracts choices_id and option_id (top-level first, metadata fallback) and HTTP POST / forwards them", async () => {
    // 1. Flattened phone POST / shape
    const flat = normalizeInboundPayload({
      type: "choice_response",
      content: "Yes, proceed",
      choices_id: "perm-111",
      option_id: "allow_once",
      selections: ["Yes, proceed"],
    });
    expect(flat.meta.type).toBe("choice_response");
    expect(flat.meta.choices_id).toBe("perm-111");
    expect(flat.meta.option_id).toBe("allow_once");

    // 2. Nested metadata fallback
    const nested = normalizeInboundPayload({
      message: "Deny",
      metadata: {
        type: "choice_response",
        choices_id: "perm-222",
        option_id: "reject_once",
      },
    });
    expect(nested.meta.choices_id).toBe("perm-222");
    expect(nested.meta.option_id).toBe("reject_once");

    // 3. Top-level wins over nested metadata
    const both = normalizeInboundPayload({
      type: "choice_response",
      content: "Allow",
      choices_id: "top-id",
      option_id: "top-opt",
      metadata: {
        type: "choice_response",
        choices_id: "old-id",
        option_id: "old-opt",
      },
    });
    expect(both.meta.choices_id).toBe("top-id");
    expect(both.meta.option_id).toBe("top-opt");

    // 4. End-to-end HTTP POST / delivery to onInbound
    process.env.HITL_CHANNEL_API_KEY = "choices-http-key";
    const received: InboundMessage[] = [];
    const bridge = startHttpBridge(
      {
        async onInbound(input) {
          received.push(input);
          return { acpSessionId: "s-http" };
        },
        async onPairingCode() {},
      },
      { port: 0 },
    );
    cleanups.push(() => bridge.stop(true));

    const res = await fetch(`http://127.0.0.1:${bridge.port}/`, {
      method: "POST",
      headers: {
        authorization: "Bearer choices-http-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "choice_response",
        content: "Yes, proceed",
        choices_id: "perm-http-9",
        option_id: "accept_always",
        selections: ["Yes, proceed"],
      }),
    });
    expect(res.status).toBe(200);
    expect(received.length).toBe(1);
    expect(received[0]!.meta.choices_id).toBe("perm-http-9");
    expect(received[0]!.meta.option_id).toBe("accept_always");
  });

  it("AV7: exact permission correlation across concurrent permissions, option_id priority, fail-closed stale choices_id, legacy omit fallback, and choices_settled", async () => {
    const replies: Array<{ text: string; acpSessionId?: string | null }> = [];
    const unicastFrames: Array<Record<string, unknown>> = [];
    const permissionResponses: Array<{ id: unknown; result: unknown }> = [];
    let holdPromptResolve: (() => void) | null = null;
    const peers: FakePeerTransport[] = [];

    const capableWs: HitlWebSocket & { frames: Array<Record<string, unknown>> } = {
      readyState: 1,
      data: {
        tokenHash: "cap-1",
        proto: 3,
        features: new Set(["sessions", "choices_settled"]),
      },
      send(raw: string) {
        this.frames.push(JSON.parse(raw) as Record<string, unknown>);
        return 1;
      },
      frames: [],
    };
    const legacyWs: HitlWebSocket & { frames: Array<Record<string, unknown>> } = {
      readyState: 1,
      data: { tokenHash: "leg-1" },
      send(raw: string) {
        this.frames.push(JSON.parse(raw) as Record<string, unknown>);
        return 1;
      },
      frames: [],
    };
    clients.add(capableWs);
    clients.add(legacyWs);

    const manager = new AcpSessionManager({
      harness: "agy",
      defaultCwd: tempHome,
      mcpUrl: "http://127.0.0.1:45557/mcp",
      mcpToken: "tok",
      instanceId: "inst-p3a-choices",
      transportFactory: () => {
        const p = new FakePeerTransport((msg, peer) => {
          if (msg.method === "initialize") {
            peer.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: 1, agentCapabilities: {} },
            });
          } else if (msg.method === "session/new") {
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-perm" } });
          } else if (msg.method === "session/prompt") {
            const text = String(((msg.params as any).prompt[0] as any).text);
            if (text === "two-perms") {
              peer.emit({
                jsonrpc: "2.0",
                id: 901,
                method: "session/request_permission",
                params: {
                  sessionId: "s-perm",
                  toolCall: { toolCallId: "t1", name: "bash", title: "Run ls" },
                  options: [
                    { optionId: "allow_once", name: "Allow", kind: "allow_once" },
                    { optionId: "allow_always", name: "Allow", kind: "allow_always" },
                    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
                  ],
                },
              });
              peer.emit({
                jsonrpc: "2.0",
                id: 902,
                method: "session/request_permission",
                params: {
                  sessionId: "s-perm",
                  toolCall: { toolCallId: "t2", name: "write_file", title: "Edit README" },
                  options: [
                    { optionId: "allow_second", name: "Approve Edit", kind: "allow_once" },
                    { optionId: "deny_second", name: "Reject Edit", kind: "reject_once" },
                  ],
                },
              });
              holdPromptResolve = () =>
                peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
              return;
            }
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          } else if ("id" in msg && (msg.id === 901 || msg.id === 902)) {
            permissionResponses.push({ id: msg.id, result: msg.result });
          }
        });
        peers.push(p);
        return p;
      },
      broadcastReplyFn: (text, _msgId, _agentId, _atts, opts) => {
        replies.push({ text, acpSessionId: opts?.acpSessionId ?? null });
        return `r-${replies.length}`;
      },
      unicastFrameFn: (frame) => {
        unicastFrames.push(frame);
        return { delivered: true, targetDevice: "dev-1" };
      },
      auditFn: async () => {},
    });
    cleanups.push(() => manager.shutdown());

    const handlers = manager.getInboundHandlers();
    await handlers.onInbound({ text: "two-perms", meta: {} });
    await waitFor(() => unicastFrames.length === 2);

    const frame1 = unicastFrames[0]!;
    const frame2 = unicastFrames[1]!;
    expect(frame1.category).toBe("permission");
    expect(frame1.toolName).toBe("bash");
    expect(frame1.acpSessionId).toBe("s-perm");
    expect(frame1.options).toEqual([
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      { optionId: "allow_always", name: "Allow", kind: "allow_always" },
      { optionId: "reject_once", name: "Deny", kind: "reject_once" },
    ]);
    expect(frame2.category).toBe("permission");
    expect(frame2.toolName).toBe("write_file");
    expect(frame2.acpSessionId).toBe("s-perm");

    // Answer the SECOND permission by choices_id + option_id (even with mismatched text!) -> resolves rpcId 902, leaves 901 untouched!
    await handlers.onInbound({
      text: "completely mismatched label",
      meta: {
        type: "choice_response",
        choices_id: String(frame2.id),
        option_id: "deny_second",
      },
    });
    expect(permissionResponses.length).toBe(1);
    expect(permissionResponses[0]).toEqual({
      id: 902,
      result: { outcome: { outcome: "selected", optionId: "deny_second" } },
    });
    expect(manager.getStateSnapshot().pendingPermissionCount).toBe(1);

    // choices_settled delivered ONLY to capableWs, NEVER legacyWs
    expect(capableWs.frames.some((f) => f.type === "choices_settled")).toBe(true);
    const settled2 = capableWs.frames.find((f) => f.type === "choices_settled")!;
    expect(settled2).toEqual({
      type: "choices_settled",
      frameIds: [String(frame2.id)],
      acpSessionId: "s-perm",
      reason: "answered",
      selectedLabel: "Reject Edit",
    });
    expect(legacyWs.frames.some((f) => f.type === "choices_settled")).toBe(false);

    // Re-tapping stale frame2.id fails closed and NEVER touches sibling perm 901!
    await handlers.onInbound({
      text: "Allow",
      meta: {
        type: "choice_response",
        choices_id: String(frame2.id),
        option_id: "allow_second",
      },
    });
    expect(replies.at(-1)?.text).toBe("approval expired or already resolved");
    expect(permissionResponses.length).toBe(1);
    expect(manager.getStateSnapshot().pendingPermissionCount).toBe(1);

    // Answer frame1 using option_id="allow_always" to distinguish identical "Allow" labels -> resolves allow_always (NOT allow_once)!
    await handlers.onInbound({
      text: "Allow",
      meta: {
        type: "choice_response",
        choices_id: String(frame1.id),
        option_id: "allow_always",
      },
    });
    expect(permissionResponses.length).toBe(2);
    expect(permissionResponses[1]).toEqual({
      id: 901,
      result: { outcome: { outcome: "selected", optionId: "allow_always" } },
    });
    expect(manager.getStateSnapshot().pendingPermissionCount).toBe(0);

    holdPromptResolve!();
    await waitFor(() => !manager.getStateSnapshot().turnBusy);

    // Legacy omit choices_id still resolves pendingPermissions[0] FIFO and emits choices_settled on /cancel
    unicastFrames.length = 0;
    permissionResponses.length = 0;
    capableWs.frames.length = 0;

    await handlers.onInbound({ text: "two-perms", meta: {} });
    await waitFor(() => unicastFrames.length === 2);

    // Omit choices_id -> resolves [0] (901) FIFO
    await handlers.onInbound({
      text: "Deny",
      meta: { type: "choice_response" },
    });
    expect(permissionResponses[0]).toEqual({
      id: 901,
      result: { outcome: { outcome: "selected", optionId: "reject_once" } },
    });

    // /cancel cancels remaining perm 902 and broadcasts choices_settled{reason:"cancelled"}
    await handlers.onInbound({ text: "/cancel", meta: {} });
    expect(permissionResponses[1]).toEqual({
      id: 902,
      result: { outcome: { outcome: "cancelled" } },
    });
    const cancelSettled = capableWs.frames.find(
      (f) => f.type === "choices_settled" && f.reason === "cancelled",
    )!;
    expect(cancelSettled).toEqual({
      type: "choices_settled",
      frameIds: [String(unicastFrames[1]!.id)],
      acpSessionId: "s-perm",
      reason: "cancelled",
    });
    expect(legacyWs.frames.some((f) => f.type === "choices_settled")).toBe(false);

    holdPromptResolve!();
    await waitFor(() => !manager.getStateSnapshot().turnBusy);

    // Crash cancellation also emits choices_settled{reason:"cancelled"}
    unicastFrames.length = 0;
    capableWs.frames.length = 0;
    await handlers.onInbound({ text: "two-perms", meta: {} });
    await waitFor(() => unicastFrames.length === 2);
    peers[0]!.crash(137);
    const crashSettled = capableWs.frames.find(
      (f) => f.type === "choices_settled" && f.reason === "cancelled",
    )!;
    expect(crashSettled.frameIds).toEqual([
      String(unicastFrames[0]!.id),
      String(unicastFrames[1]!.id),
    ]);
  });

  it("AV7: openUserChoiceIds exact match queues behind active turn (never concurrent startTurn) and fails closed on stale id", async () => {
    const replies: Array<{ text: string }> = [];
    const promptLog: string[] = [];
    let activeTurnCount = 0;
    let maxConcurrentTurns = 0;
    let releaseHold!: () => void;

    const manager = new AcpSessionManager({
      harness: "agy",
      defaultCwd: tempHome,
      mcpUrl: "http://127.0.0.1:45558/mcp",
      mcpToken: "tok",
      instanceId: "inst-open-choices",
      transportFactory: () =>
        new FakePeerTransport((msg, peer) => {
          if (msg.method === "initialize") {
            peer.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: 1, agentCapabilities: {} },
            });
          } else if (msg.method === "session/new") {
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-uc" } });
          } else if (msg.method === "session/prompt") {
            activeTurnCount++;
            maxConcurrentTurns = Math.max(maxConcurrentTurns, activeTurnCount);
            const text = String(((msg.params as any).prompt[0] as any).text);
            promptLog.push(text);
            if (text === "long-turn") {
              releaseHold = () => {
                activeTurnCount--;
                peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
              };
              return;
            }
            activeTurnCount--;
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          }
        }),
      broadcastReplyFn: (text) => {
        replies.push({ text });
        return `r-${replies.length}`;
      },
      unicastFrameFn: () => ({ delivered: true, targetDevice: "dev-1" }),
      auditFn: async () => {},
    });
    cleanups.push(() => manager.shutdown());

    const handlers = manager.getInboundHandlers();

    // Present two open user choices while turn is busy
    await handlers.onInbound({ text: "long-turn", meta: {} });
    await waitFor(() => typeof releaseHold === "function");

    manager.onChoicesPresented("choice-1");
    manager.onChoicesPresented("choice-2");
    expect(manager.getStateSnapshot().openUserChoices).toBe(2);

    // Exact match for choice-2 while turnBusy -> deletes choice-2, queues FIFO (NO concurrent startTurn!)
    await handlers.onInbound({
      text: "Option Two",
      meta: { type: "choice_response", choices_id: "choice-2" },
    });
    expect(manager.getStateSnapshot().openUserChoices).toBe(1);
    expect(manager.getStateSnapshot().queueDepth).toBe(1);
    expect(replies.at(-1)?.text).toBe("⏳ queued (1 ahead)");
    expect(maxConcurrentTurns).toBe(1);
    expect(promptLog).toEqual(["long-turn"]);

    // Duplicate choice-2 tap fails closed without touching choice-1
    await handlers.onInbound({
      text: "Option Two",
      meta: { type: "choice_response", choices_id: "choice-2" },
    });
    expect(replies.at(-1)?.text).toBe("approval expired or already resolved");
    expect(manager.getStateSnapshot().openUserChoices).toBe(1);

    // Release long-turn -> queued Option Two runs cleanly
    releaseHold();
    await waitFor(() => promptLog.includes("Option Two") && !manager.getStateSnapshot().turnBusy);
    expect(maxConcurrentTurns).toBe(1);
    expect(promptLog).toEqual(["long-turn", "Option Two"]);

    // Legacy omit choices_id consumes oldest open choice (choice-1) when idle
    await handlers.onInbound({
      text: "Option One",
      meta: { type: "choice_response" },
    });
    await waitFor(() => promptLog.includes("Option One") && !manager.getStateSnapshot().turnBusy);
    expect(manager.getStateSnapshot().openUserChoices).toBe(0);
  });
});
