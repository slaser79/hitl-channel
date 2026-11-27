import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpTransport } from "../acp_client.js";
import { AcpSessionManager } from "../acp_session_manager.js";
import type { AuditEvent } from "../audit.js";
import { DAEMON_INSTRUCTIONS } from "../mcp_instructions.js";

class FakePeerTransport implements AcpTransport {
  readonly pid = 99999;
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for predicate");
}

describe("AcpSessionManager (unit — AV3, AV4, AV5, AV8, AV9, AV10)", () => {
  let prevHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "hitl-sm-home-"));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  function createHarness(opts?: {
    outOfTurnQuietMs?: number;
    defaultCwd?: string;
    onOutbound?: (msg: Record<string, unknown>, peer: FakePeerTransport, spawnIdx: number) => void;
  }) {
    const peers: FakePeerTransport[] = [];
    const replies: Array<{ text: string; messageId?: string }> = [];
    const frames: Array<Record<string, unknown>> = [];
    const audits: AuditEvent[] = [];

    const manager = new AcpSessionManager({
      harness: "agy",
      defaultCwd: opts?.defaultCwd ?? tempHome,
      mcpUrl: "http://127.0.0.1:45555/mcp",
      mcpToken: "secret-mcp-token",
      instanceId: "daemon-inst-1",
      outOfTurnQuietMs: opts?.outOfTurnQuietMs ?? 40,
      transportFactory: () => {
        const spawnIdx = peers.length;
        const peer = new FakePeerTransport((msg, p) => {
          if (opts?.onOutbound) {
            opts.onOutbound(msg, p, spawnIdx);
            return;
          }
          if (msg.method === "initialize") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {
                  loadSession: true,
                  sessionCapabilities: { resume: {}, list: {} },
                  promptCapabilities: { image: true },
                },
              },
            });
          } else if (msg.method === "session/new") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessionId: `sess-${spawnIdx + 1}` },
            });
          }
        });
        peers.push(peer);
        return peer;
      },
      broadcastReplyFn: (text, messageId) => {
        replies.push({ text, messageId });
      },
      unicastFrameFn: (frame) => {
        frames.push(frame);
        return { delivered: true, targetDevice: "dev-1" };
      },
      auditFn: async (evt) => {
        audits.push(evt);
      },
    });

    return { manager, peers, replies, frames, audits, handlers: manager.getInboundHandlers() };
  }

  it("AV4: image attachment becomes ACP image block without inbox write; non-image writes to inbox", async () => {
    const capturedPrompts: Array<Record<string, unknown>> = [];
    const { manager, handlers } = createHarness({
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-att" } });
        } else if (msg.method === "session/prompt") {
          capturedPrompts.push(msg.params as Record<string, unknown>);
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        }
      },
    });

    await handlers.onInbound({
      text: "Inspect these",
      attachments: [
        { type: "image", media_type: "image/png", data: "aGVsbG8=", fileName: "pic.png" },
        { type: "file", media_type: "application/pdf", data: Buffer.from("%PDF-1.4").toString("base64"), fileName: "spec.pdf" },
      ],
      meta: { sender_id: "ceo" },
    });

    await waitFor(() => capturedPrompts.length === 1);
    const blocks = capturedPrompts[0]!.prompt as Array<Record<string, unknown>>;
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.type).toBe("text");
    expect(String(blocks[0]!.text)).toContain("Inspect these");
    expect(String(blocks[0]!.text)).toContain("[File: ");
    expect(String(blocks[0]!.text)).toContain("spec.pdf]");
    expect(blocks[1]).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });

    const inboxDir = join(tempHome, ".claude", "channels", "hitl-channel", "inbox");
    expect(readdirSync(inboxDir)).toEqual(["spec.pdf"]);
    await manager.shutdown();
  });

  it("AV5: joins in-turn chunks, enforces empty-turn reply rules, and isolates out-of-turn output", async () => {
    let promptCount = 0;
    let triggerOutOfTurn!: (peer: FakePeerTransport) => void;
    const { manager, peers, replies, handlers } = createHarness({
      outOfTurnQuietMs: 30,
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-turn" } });
        } else if (msg.method === "session/prompt") {
          promptCount++;
          const idx = promptCount;
          if (idx === 1) {
            peer.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-turn", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } } } });
            peer.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-turn", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } } } });
            peer.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-turn", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "c" } } } });
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          } else if (idx === 2) {
            // Empty turn without reply_to_hitl -> fallback reply
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          } else if (idx === 3) {
            // Empty end_turn with reply_to_hitl -> NO extra reply
            manager.onReplySent("s-turn");
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          } else if (idx === 4) {
            // Empty delegation turn even if reply_to_hitl called -> MUST emit fallback with message_id
            manager.onReplySent("s-turn");
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          } else if (idx === 5) {
            // Normal reply after out-of-turn output
            peer.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-turn", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "NEXT_TURN" } } } });
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          }
        }
      },
    });
    triggerOutOfTurn = (p) => {
      p.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s-turn",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "BG_WAKE" } },
        },
      });
    };

    // Turn 1: a+b+c -> "abc"
    await handlers.onInbound({ text: "t1", meta: { client_message_id: "cm-1" } });
    await waitFor(() => replies.some((r) => r.text === "abc"));
    expect(replies.find((r) => r.text === "abc")?.messageId).toBe("cm-1");

    // Turn 2: empty without reply_to_hitl
    await handlers.onInbound({ text: "t2", meta: {} });
    await waitFor(() => replies.some((r) => r.text === "(no text output — stopReason: end_turn)"));

    // Turn 3: empty end_turn with reply_to_hitl -> zero extra replies
    const countBefore3 = replies.length;
    await handlers.onInbound({ text: "t3", meta: {} });
    await waitFor(() => promptCount === 3);
    await new Promise((r) => setTimeout(r, 30));
    expect(replies.length).toBe(countBefore3);

    // Turn 4: delegation empty even with reply_to_hitl -> resolves with message_id X-9
    await handlers.onInbound({ text: '<workflow_delegation message_id="X-9">do it</workflow_delegation>', meta: {} });
    await waitFor(() => replies.some((r) => r.messageId === "X-9"));
    expect(replies.find((r) => r.messageId === "X-9")?.text).toBe("(no text output — stopReason: end_turn)");

    // Out-of-turn output followed by Turn 5 -> out-of-turn flushed standalone, never mixed into Turn 5
    triggerOutOfTurn(peers[0]!);
    await waitFor(() => replies.some((r) => r.text === "BG_WAKE"));
    await handlers.onInbound({ text: "t5", meta: {} });
    await waitFor(() => replies.some((r) => r.text === "NEXT_TURN"));
    const turn5Reply = replies.find((r) => r.text === "NEXT_TURN");
    expect(turn5Reply?.text).toBe("NEXT_TURN");

    await manager.shutdown();
  });

  it("AV8 & AV9: permission card, queueing, reconnect replay, auto-allow fixtures, openUserChoices reset, delegation", async () => {
    const permissionOutcomes: Array<Record<string, unknown>> = [];
    const promptsReceived: string[] = [];
    let holdTurnResolve: (() => void) | null = null;

    const { manager, replies, frames, audits, handlers } = createHarness({
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-perm" } });
        } else if (msg.method === "session/prompt") {
          const text = String(((msg.params as any).prompt[0] as any).text);
          promptsReceived.push(text);
          if (text === "trigger-auto-and-manual") {
            // 1. Auto-allow fixture A: toolCall.name
            peer.emit({
              jsonrpc: "2.0",
              id: 701,
              method: "session/request_permission",
              params: {
                sessionId: "s-perm",
                toolCall: { toolCallId: "tc-a", name: "mcp_hitl-channel_call_phone_tool", rawInput: { a: 1 } },
                options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
              },
            });
            // 2. Auto-allow fixture B: no name, title = Run mcp_hitl-channel_*
            peer.emit({
              jsonrpc: "2.0",
              id: 702,
              method: "session/request_permission",
              params: {
                sessionId: "s-perm",
                toolCall: { toolCallId: "tc-b", title: "Run mcp_hitl-channel_call_phone_tool", rawInput: { b: 2 } },
                options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
              },
            });
            // 3. Non-hitl tool -> goes to phone (with >300 char input to verify truncation)
            peer.emit({
              jsonrpc: "2.0",
              id: 703,
              method: "session/request_permission",
              params: {
                sessionId: "s-perm",
                toolCall: { toolCallId: "tc-c", name: "bash", title: "Run shell", rawInput: { cmd: "x".repeat(400) } },
                options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
              },
            });
            holdTurnResolve = () => peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
            return;
          }
          if (text.includes("<workflow_delegation message_id=\"DEL-1\">")) {
            manager.onReplySent("s-perm");
            peer.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-perm", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "DELEGATION_OK" } } } });
          }
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        } else if ("id" in msg && Number(msg.id) >= 701) {
          permissionOutcomes.push(msg);
          if (msg.id === 703) {
            holdTurnResolve?.();
            holdTurnResolve = null;
          }
        }
      },
    });

    // No pending permission & no open choice card -> "no pending approval"
    await handlers.onInbound({ text: "Allow", meta: { type: "choice_response", selections: ["Allow"] } });
    expect(replies.at(-1)?.text).toBe("no pending approval");
    expect(promptsReceived.length).toBe(0);

    // Open user choice card -> choice_response forwards as prompt; 2nd gets "no pending approval"
    manager.onChoicesPresented();
    await handlers.onInbound({ text: "Option A", meta: { type: "choice_response", selections: ["Option A"] } });
    await waitFor(() => promptsReceived.includes("Option A") && !manager.getStateSnapshot().turnBusy);
    await handlers.onInbound({ text: "Option B", meta: { type: "choice_response", selections: ["Option B"] } });
    expect(replies.at(-1)?.text).toBe("no pending approval");

    // Plain prompt resets stale openUserChoices
    manager.onChoicesPresented();
    await handlers.onInbound({ text: "plain prompt resets choices", meta: {} });
    await waitFor(() => promptsReceived.includes("plain prompt resets choices") && !manager.getStateSnapshot().turnBusy);
    await handlers.onInbound({ text: "Stale Choice", meta: { type: "choice_response" } });
    expect(replies.at(-1)?.text).toBe("no pending approval");

    // Trigger auto-allow + manual permission
    await handlers.onInbound({ text: "trigger-auto-and-manual", meta: {} });
    await waitFor(() => frames.length === 1);
    expect(permissionOutcomes.filter((o) => o.id === 701 || o.id === 702)).toHaveLength(2);
    expect(frames[0]!.choices).toEqual(["Allow", "Deny"]);
    expect(String(frames[0]!.content).length).toBeLessThanOrEqual(300);

    // Verify auto-allow audit rows
    await waitFor(() => audits.filter((a) => a.kind === "permission" && a.approval === "auto").length === 2);
    expect(audits.some((a) => a.kind === "permission" && a.tool_name === "mcp_hitl-channel_call_phone_tool" && a.approval === "auto")).toBe(true);

    // Reconnect replay carries exact original frame id
    const replayed: Array<Record<string, unknown>> = [];
    handlers.onClientOpen?.((f) => {
      replayed.push(f);
      return true;
    });
    expect(replayed.length).toBe(1);
    expect(replayed[0]!.id).toBe(frames[0]!.id);

    // Plain message while approval pending gets queued with waiting reply
    await handlers.onInbound({ text: "queued behind perm", meta: {} });
    expect(replies.at(-1)?.text).toBe("⚠ waiting for your approval above (queued)");

    // Approve permission -> 1 outcome sent, queued message runs after turn
    await handlers.onInbound({ text: "allow", meta: { type: "choice_response" } });
    const perm703 = permissionOutcomes.find((o) => o.id === 703);
    expect((perm703 as any).result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    await waitFor(() => promptsReceived.includes("queued behind perm"));

    // Second tap afterwards gets "no pending approval"
    await handlers.onInbound({ text: "Allow", meta: { type: "choice_response" } });
    expect(replies.at(-1)?.text).toBe("no pending approval");

    // AV9: Workflow delegation end-of-turn reply gets message_id DEL-1
    await handlers.onInbound({ text: '<workflow_delegation message_id="DEL-1">work</workflow_delegation>', meta: {} });
    await waitFor(() => replies.some((r) => r.messageId === "DEL-1" && r.text === "DELEGATION_OK"));

    await manager.shutdown();
  });

  it("AV10: /new grammar, /sessions top-10 + active append, /resume vs load replay suppression, /cancel, /status, /help, queueing, crash restart", async () => {
    const subDir = join(tempHome, "subproj");
    mkdirSync(subDir, { recursive: true });

    let advertiseResume = true;
    let activePromptResolve: (() => void) | null = null;
    const rpcLog: Array<{ method: string; params: Record<string, unknown> }> = [];

    const sessionsCatalog = Array.from({ length: 12 }, (_, i) => ({
      sessionId: `hist-${i + 1}`,
      title: `Hist ${i + 1}`,
      cwd: tempHome,
      updatedAt: new Date(Date.UTC(2026, 10, 21, 12, 12 - i, 0)).toISOString(),
    }));
    // Make hist-12 (oldest!) the current session later or create sess-1 and test

    const { manager, peers, replies, handlers } = createHarness({
      onOutbound: (msg, peer, spawnIdx) => {
        if (typeof msg.method === "string") {
          rpcLog.push({ method: msg.method, params: (msg.params ?? {}) as Record<string, unknown> });
        }
        if (msg.method === "initialize") {
          peer.emit({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                sessionCapabilities: advertiseResume ? { resume: {}, list: {} } : { list: {} },
              },
            },
          });
        } else if (msg.method === "session/new") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: `new-${spawnIdx}-${rpcLog.length}` } });
        } else if (msg.method === "session/list") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessions: sessionsCatalog } });
        } else if (msg.method === "session/resume") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
        } else if (msg.method === "session/load") {
          // Emit replayed history during load (must be ignored!)
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: (msg.params as any).sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "IGNORED_REPLAY" } },
            },
          });
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
        } else if (msg.method === "session/prompt") {
          const text = String(((msg.params as any).prompt[0] as any).text);
          if (text === "slow") {
            peer.emit({
              jsonrpc: "2.0",
              id: 801,
              method: "session/request_permission",
              params: {
                sessionId: (msg.params as any).sessionId,
                toolCall: { name: "bash", title: "Run slow" },
                options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
              },
            });
            activePromptResolve = () => peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "cancelled" } });
          } else {
            peer.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: (msg.params as any).sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ok:${text}` } } },
            });
            peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          }
        } else if (msg.method === "session/cancel") {
          activePromptResolve?.();
          activePromptResolve = null;
        }
      },
    });

    // /help & /status & /cancel with nothing running
    await handlers.onInbound({ text: "/help", meta: {} });
    expect(replies.at(-1)?.text).toContain("/new");
    await handlers.onInbound({ text: "/status", meta: {} });
    expect(replies.at(-1)?.text).toContain("Harness: agy");
    await handlers.onInbound({ text: "/cancel", meta: {} });
    expect(replies.at(-1)?.text).toBe("nothing running");

    // /new hermes and /new /nonexistent -> errors, 0 ACP calls
    const rpcsBeforeErr = rpcLog.length;
    await handlers.onInbound({ text: "/new hermes", meta: {} });
    expect(replies.at(-1)?.text).toContain("Unsupported harness");
    await handlers.onInbound({ text: "/new /definitely_nonexistent_dir_xyz", meta: {} });
    expect(replies.at(-1)?.text).toContain("Directory does not exist");
    expect(rpcLog.length).toBe(rpcsBeforeErr);

    // /new ~/subproj -> absolute cwd, http MCP bearer + pre-minted mcpBindingId, _meta.antigravity.systemPrompt.append
    await handlers.onInbound({ text: "/new ~/subproj", meta: {} });
    const newCall = rpcLog.find((r) => r.method === "session/new");
    expect(newCall?.params.cwd).toBe(subDir);
    const newMcp = (newCall?.params.mcpServers as Array<{ type: string; name: string; url: string; headers: Array<{ name: string; value: string }> }>)?.[0];
    expect(newMcp?.type).toBe("http");
    expect(newMcp?.name).toBe("hitl-channel");
    expect(newMcp?.url).toBe("http://127.0.0.1:45555/mcp");
    expect(newMcp?.headers[0]).toEqual({ name: "Authorization", value: "Bearer secret-mcp-token" });
    expect(newMcp?.headers[1]?.name).toBe("X-Hitl-Acp-Session-Id");
    const bindingId = newMcp?.headers[1]?.value ?? "";
    expect(bindingId.length).toBeGreaterThan(0);
    expect(manager.resolveBoundAcpSessionId(bindingId)).toBe("new-0-2");
    expect((newCall?.params._meta as any)?.antigravity?.systemPrompt?.append).toBe(DAEMON_INSTRUCTIONS);

    // /sessions -> top 10 + active (outside top 10) appended at #11
    await handlers.onInbound({ text: "/sessions", meta: {} });
    const sessLines = replies.at(-1)!.text.split("\n");
    expect(sessLines.length).toBe(11);
    expect(sessLines[10]).toContain("[active]");

    // /resume 2 -> session/resume with cwd, mcpServers, _meta
    await handlers.onInbound({ text: "/resume 2", meta: {} });
    const resumeCall = rpcLog.find((r) => r.method === "session/resume");
    expect(resumeCall?.params.sessionId).toBe("hist-2");
    expect(resumeCall?.params.cwd).toBe(tempHome);
    expect(resumeCall?.params.mcpServers).toBeDefined();
    expect((resumeCall?.params._meta as any)?.antigravity?.systemPrompt?.append).toBe(DAEMON_INSTRUCTIONS);

    // /cancel while turn + permission pending -> cancels permission first, ends turn cancelled
    await handlers.onInbound({ text: "slow", meta: {} });
    await waitFor(() => peers[0]!.sent.some((m) => m.method === "session/prompt"));
    await handlers.onInbound({ text: "/cancel", meta: {} });
    await waitFor(() => replies.some((r) => r.text === "⏹ cancelled"));
    const permCancelResp = peers[0]!.sent.find((m) => m.id === 801);
    expect((permCancelResp as any).result).toEqual({ outcome: { outcome: "cancelled" } });

    // Crash #1 -> error reply + /resume hint + 1 automatic restart; Crash #2 within 60s -> stops restarts
    peers[0]!.crash(137);
    await waitFor(() => peers.length === 2);
    expect(replies.some((r) => r.text.includes("137") && r.text.includes("/resume"))).toBe(true);

    // Fallback to session/load when resume unadvertised
    advertiseResume = false;
    peers[1]!.crash(1);
    // 2nd crash within 60s stops automatic restart
    await waitFor(() => replies.some((r) => r.text.includes("crashed repeatedly")));
    expect(peers.length).toBe(2);

    // Separate harness without resume capability to verify session/load replay suppression
    const noResHarness = createHarness({
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } } });
        } else if (msg.method === "session/list") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessions: [{ sessionId: "old-1", cwd: tempHome, title: "Old" }] } });
        } else if (msg.method === "session/load") {
          peer.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "old-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "IGNORED_REPLAY" } } } });
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
        }
      },
    });
    await noResHarness.handlers.onInbound({ text: "/sessions", meta: {} });
    await noResHarness.handlers.onInbound({ text: "/resume 1", meta: {} });
    await new Promise((r) => setTimeout(r, 60));
    expect(noResHarness.replies.some((r) => r.text.includes("IGNORED_REPLAY"))).toBe(false);
    expect(noResHarness.replies.at(-1)?.text).toBe("▶ Resumed `Old`");

    await noResHarness.manager.shutdown();
    await manager.shutdown();
  });

  it("adversarial lifecycle: queues prompt arriving during in-flight /new and closes transport on shutdown during initialize", async () => {
    let releaseNew!: () => void;
    const promptedSessionIds: string[] = [];

    const switchHarness = createHarness({
      onOutbound: (msg, peer) => {
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          releaseNew = () => peer.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "switched-sess" } });
        } else if (msg.method === "session/prompt") {
          promptedSessionIds.push(String((msg.params as any).sessionId));
          peer.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: (msg.params as any).sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after-new" } } } });
          peer.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        }
      },
    });

    const newPromise = switchHarness.handlers.onInbound({ text: "/new", meta: {} });
    await waitFor(() => typeof releaseNew === "function");
    await switchHarness.handlers.onInbound({ text: "hello mid-new", meta: {} });
    expect(switchHarness.replies.at(-1)?.text).toBe("⏳ queued (1 ahead)");

    releaseNew();
    await newPromise;
    await waitFor(() => switchHarness.replies.some((r) => r.text === "after-new"));
    expect(promptedSessionIds).toEqual(["switched-sess"]);
    await switchHarness.manager.shutdown();

    // dispose-during-start: shutdown while initialize() has not yet responded
    const initHangingHarness = createHarness({
      onOutbound: () => {
        // intentionally never respond to initialize
      },
    });
    const startP = initHangingHarness.manager.start().catch((err) => err as Error);
    await waitFor(() => initHangingHarness.peers.length === 1);
    await initHangingHarness.manager.shutdown();
    const err = await startP;
    expect(initHangingHarness.peers[0]!.closed).toBe(true);
    expect(err).toBeInstanceOf(Error);
  });
});
