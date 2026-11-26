import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { spawnAcpTransport, type AcpTransport } from "../acp_client.js";
import { AcpSessionManager } from "../acp_session_manager.js";
import { startDaemon } from "../daemon.js";
import {
  clients,
  replyBuffer,
  sendControlToClient,
  startHttpBridge,
} from "../http_bridge.js";
import type {
  CommandsListFrame,
  HitlWebSocket,
  ModelsStateFrame,
  SessionErrorFrame,
} from "../types.js";

const FAKE_MC_AGENT_PATH = join(
  import.meta.dir,
  "fixtures",
  "fake_models_commands_acp_agent.ts",
);

class FakePeerTransport implements AcpTransport {
  readonly pid = 99100;
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb(0, null);
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

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

function makeWs(opts?: {
  proto?: number;
  features?: string[];
}): HitlWebSocket & { frames: Array<Record<string, unknown>> } {
  const frames: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    data: {
      tokenHash: `ws-${Math.random().toString(36).slice(2, 8)}`,
      ...(opts?.proto !== undefined ? { proto: opts.proto } : {}),
      ...(opts?.features !== undefined ? { features: new Set(opts.features) } : {}),
    },
    send(raw: string) {
      frames.push(JSON.parse(raw) as Record<string, unknown>);
      return 1;
    },
    frames,
  };
}

describe("SPEC-HITL-APP-10831 Phase 2 AV5 & AV6: models, session_set_model, commands_list", () => {
  let prevHome: string | undefined;
  let prevApiKey: string | undefined;
  let tempHome: string;
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevApiKey = process.env.HITL_CHANNEL_API_KEY;
    tempHome = mkdtempSync(join(process.env.HITL_CHANNEL_TEST_ROOT || tmpdir(), "hitl-10831-p2-"));
    process.env.HOME = tempHome;
    process.env.HITL_CHANNEL_API_KEY = "p2-mc-key";
    clients.clear();
    replyBuffer.drain();
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
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

  function createManagerHarness(opts: {
    harness?: "agy" | "codex" | "hermes";
    sessionLoadTimeoutMs?: number;
    onOutbound: (msg: Record<string, unknown>, peer: FakePeerTransport) => void;
  }) {
    const peers: FakePeerTransport[] = [];
    const replies: Array<{ text: string; acpSessionId?: string | null }> = [];
    const manager = new AcpSessionManager({
      harness: opts.harness ?? "agy",
      defaultCwd: tempHome,
      mcpUrl: "http://127.0.0.1:45556/mcp",
      mcpToken: "tok",
      instanceId: "inst-10831-p2",
      outOfTurnQuietMs: 25,
      sessionLoadTimeoutMs: opts.sessionLoadTimeoutMs,
      transportFactory: () => {
        const p = new FakePeerTransport((msg, peer) => opts.onOutbound(msg, peer));
        peers.push(p);
        return p;
      },
      broadcastReplyFn: (text, _msgId, _agentId, _atts, replyOpts) => {
        replies.push({ text, acpSessionId: replyOpts?.acpSessionId ?? null });
        return `r-${replies.length}`;
      },
      broadcastToCapableFn: (feature, frame) => {
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
    return { manager, peers, replies, handlers: manager.getInboundHandlers() };
  }

  it("AV5/AV6: /instance sets models:true, commands:true on daemon and false on server.ts (:8789) and default bridge", async () => {
    const channelPort = await getFreePort();
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.BUN_ENV;
    env.NODE_ENV = "production";
    env.HITL_CHANNEL_PORT = String(channelPort);
    env.HITL_CHANNEL_IDENTITY_FILE = join(tempHome, "ch-id.json");

    const channelChild = spawn(process.execPath, ["run", "src/server.ts"], {
      cwd: join(import.meta.dir, "..", ".."),
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanups.push(() => {
      try {
        channelChild.stdin.end();
        channelChild.kill("SIGTERM");
      } catch {
        // ignore
      }
    });

    let channelInst: Record<string, unknown> | null = null;
    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${channelPort}/instance`);
        if (res.status === 200) {
          channelInst = (await res.json()) as Record<string, unknown>;
          return true;
        }
        return false;
      } catch {
        return false;
      }
    });
    expect(channelInst!.capabilities).toEqual({
      sessions: false,
      streaming: false,
      choicesId: true,
      models: false,
      commands: false,
    });

    const bridge = startHttpBridge({ notification: async () => {} } as unknown as Server, {
      port: 0,
    });
    cleanups.push(() => bridge.stop(true));
    const bridgeInst = (await (
      await fetch(`http://127.0.0.1:${bridge.port}/instance`)
    ).json()) as Record<string, unknown>;
    expect(bridgeInst.capabilities).toEqual({
      sessions: false,
      streaming: false,
      choicesId: true,
      models: false,
      commands: false,
    });

    const daemon = await startDaemon({
      harness: "agy",
      port: 0,
      cwd: tempHome,
      enableMdns: false,
      enableDesktopNotifications: false,
      transportFactory: (_c, _a, opts) =>
        spawnAcpTransport(process.execPath, ["run", FAKE_MC_AGENT_PATH], { cwd: opts?.cwd }),
    });
    cleanups.push(() => daemon.shutdown());
    const daemonInst = (await (
      await fetch(`http://127.0.0.1:${daemon.port}/instance`)
    ).json()) as Record<string, unknown>;
    expect(daemonInst.capabilities).toEqual({
      sessions: true,
      streaming: true,
      choicesId: true,
      models: true,
      commands: true,
    });
  });

  it("AV5: recordSessionMetadata runs across session_new, /new, startTurn lazy auto-create, session/load, session/resume, and /resume", async () => {
    let seq = 0;
    const { manager, handlers } = createManagerHarness({
      onOutbound: (msg, peer) => {
        const id = msg.id as number | undefined;
        if (id === undefined) return;
        if (msg.method === "initialize") {
          peer.emit({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                sessionCapabilities: { resume: {}, load: {}, list: {} },
              },
            },
          });
          return;
        }
        if (msg.method === "session/new") {
          const sid = `s-${++seq}`;
          peer.emit({
            jsonrpc: "2.0",
            id,
            result: {
              sessionId: sid,
              models: {
                currentModelId: `m-${seq}`,
                availableModels: [
                  { modelId: `m-${seq}`, name: `Model ${seq}` },
                  { modelId: "m-alt", name: "Model Alt" },
                ],
              },
            },
          });
          return;
        }
        if (msg.method === "session/load") {
          const sid = String((msg.params as Record<string, unknown>).sessionId);
          // Emit replay chunk + surviving commands + surviving config_option_update DURING loadingSessionIds
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "SUPPRESSED_REPLAY" },
              },
            },
          });
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [{ name: "loaded-cmd", description: "From load" }],
              },
            },
          });
          peer.emit({
            jsonrpc: "2.0",
            id,
            result: {
              models: {
                currentModelId: "m-loaded",
                availableModels: [
                  { modelId: "m-loaded", name: "Loaded Model" },
                  { modelId: "m-alt", name: "Model Alt" },
                ],
              },
            },
          });
          return;
        }
        if (msg.method === "session/resume") {
          const sid = String((msg.params as Record<string, unknown>).sessionId);
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [{ name: "resumed-cmd", description: "From resume" }],
              },
            },
          });
          peer.emit({
            jsonrpc: "2.0",
            id,
            result: {
              models: {
                currentModelId: "m-resumed",
                availableModels: [{ modelId: "m-resumed", name: "Resumed Model" }],
              },
            },
          });
          return;
        }
        if (msg.method === "session/list") {
          peer.emit({
            jsonrpc: "2.0",
            id,
            result: {
              sessions: [{ sessionId: "s-existing", cwd: tempHome, title: "Existing" }],
            },
          });
          return;
        }
        if (msg.method === "session/prompt") {
          peer.emit({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
        }
      },
    });

    const wsFull = makeWs({ proto: 4, features: ["sessions", "models", "commands"] });
    const wsProto3ModelsOnly = makeWs({ proto: 3, features: ["models"] });
    const wsSessionsOnly = makeWs({ proto: 3, features: ["sessions"] });
    const wsLegacy = makeWs();
    clients.add(wsFull);
    clients.add(wsProto3ModelsOnly);
    clients.add(wsSessionsOnly);
    clients.add(wsLegacy);

    // 1. startTurn lazy auto-create
    await handlers.onInbound({ text: "hello lazy", meta: { sender_id: "u1" } });
    await waitFor(() => wsFull.frames.some((f) => f.type === "models_state" && f.sessionId === "s-1"));
    expect((wsFull.frames.find((f) => f.type === "models_state") as unknown as ModelsStateFrame).currentModelId).toBe("m-1");
    expect(wsProto3ModelsOnly.frames.some((f) => f.type === "models_state" && f.sessionId === "s-1")).toBe(true);
    expect(wsProto3ModelsOnly.frames.some((f) => f.type === "commands_list")).toBe(false);
    expect(wsSessionsOnly.frames.some((f) => f.type === "models_state" || f.type === "commands_list")).toBe(false);
    expect(wsLegacy.frames.length).toBe(0);
    expect(replyBuffer.size()).toBe(0);

    // 2. text /new
    wsFull.frames.length = 0;
    await handlers.onInbound({ text: "/new", meta: { sender_id: "u1" } });
    const newModelFrame = wsFull.frames.find((f) => f.type === "models_state") as unknown as ModelsStateFrame;
    expect(newModelFrame.sessionId).toBe("s-2");
    expect(newModelFrame.currentModelId).toBe("m-2");

    // 3. WS session_new
    wsFull.frames.length = 0;
    await handlers.onControlFrame!(wsFull, { type: "session_new", requestId: "r-new" });
    const wsNewModelFrame = wsFull.frames.find((f) => f.type === "models_state") as unknown as ModelsStateFrame;
    expect(wsNewModelFrame.sessionId).toBe("s-3");
    expect(wsNewModelFrame.currentModelId).toBe("m-3");

    // 4. WS session_resume with includeRecentTurns: true -> session/load (performSessionLoadWithTimeout result + commands survival)
    wsFull.frames.length = 0;
    await handlers.onControlFrame!(wsFull, {
      type: "session_resume",
      sessionId: "s-existing",
      includeRecentTurns: true,
      requestId: "r-load",
    });
    const loadModelFrame = wsFull.frames.find((f) => f.type === "models_state") as unknown as ModelsStateFrame;
    expect(loadModelFrame.sessionId).toBe("s-existing");
    expect(loadModelFrame.currentModelId).toBe("m-loaded");
    const loadCmdFrame = wsFull.frames.find((f) => f.type === "commands_list") as unknown as CommandsListFrame;
    expect(loadCmdFrame.commands.some((c) => c.name === "loaded-cmd" && c.source === "host")).toBe(true);

    // 5. WS session_resume with includeRecentTurns: false -> session/resume
    wsFull.frames.length = 0;
    await handlers.onControlFrame!(wsFull, {
      type: "session_resume",
      sessionId: "s-existing",
      includeRecentTurns: false,
      requestId: "r-res",
    });
    const resModelFrame = wsFull.frames.find((f) => f.type === "models_state") as unknown as ModelsStateFrame;
    expect(resModelFrame.currentModelId).toBe("m-resumed");
    const resCmdFrame = wsFull.frames.find((f) => f.type === "commands_list") as unknown as CommandsListFrame;
    expect(resCmdFrame.commands.some((c) => c.name === "resumed-cmd" && c.source === "host")).toBe(true);

    // 6. text /resume
    wsFull.frames.length = 0;
    await handlers.onInbound({ text: "/resume s-existing", meta: { sender_id: "u1" } });
    const textResModelFrame = wsFull.frames.find((f) => f.type === "models_state") as unknown as ModelsStateFrame;
    expect(textResModelFrame.currentModelId).toBe("m-resumed");

    // 7. client_hello unicast when session active
    const lateClient = makeWs({ proto: 4, features: ["models", "commands"] });
    clients.add(lateClient);
    await handlers.onClientHello!(lateClient);
    expect(lateClient.frames.some((f) => f.type === "models_state" && f.currentModelId === "m-resumed")).toBe(true);
    expect(lateClient.frames.some((f) => f.type === "commands_list")).toBe(true);
    expect(replyBuffer.size()).toBe(0);
  });

  it("AV5: single-domain models vs configOptions, desktop config_option_update read-back (matched + unmatched warning)", async () => {
    const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    cleanups.push(() => {
      process.stderr.write = origWrite;
    });

    let seq = 0;
    const { peers, handlers } = createManagerHarness({
      onOutbound: (msg, peer) => {
        const id = msg.id as number | undefined;
        if (id === undefined) return;
        rpcCalls.push({ method: String(msg.method), params: (msg.params ?? {}) as Record<string, unknown> });

        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {} } });
          return;
        }
        if (msg.method === "session/new") {
          const idx = ++seq;
          if (idx === 1) {
            // Session 1: models domain present alongside configOptions
            peer.emit({
              jsonrpc: "2.0",
              id,
              result: {
                sessionId: "s-models",
                models: {
                  currentModelId: "gemini-4-neon-high",
                  availableModels: [
                    { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon High" },
                    { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon XHigh" },
                    { modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
                    { modelId: "gpt-6.2-sol[low]", name: "GPT 6.2 Sol Low" },
                  ],
                },
                configOptions: [
                  {
                    id: "model",
                    category: "model",
                    currentValue: "gemini-4-neon",
                    options: [{ value: "only-in-cfg", name: "Should Be Ignored" }],
                  },
                ],
              },
            });
          } else {
            // Session 2: models absent, configOptions domain authoritative
            peer.emit({
              jsonrpc: "2.0",
              id,
              result: {
                sessionId: "s-cfg",
                configOptions: [
                  {
                    id: "model_select",
                    category: "model",
                    currentValue: "cfg-a",
                    options: [
                      { value: "cfg-a", name: "Cfg A", description: "Alpha" },
                      { value: "cfg-b", name: "Cfg B", description: "Beta" },
                    ],
                  },
                ],
              },
            });
          }
          return;
        }
        if (msg.method === "session/set_model" || msg.method === "session/set_config_option") {
          peer.emit({ jsonrpc: "2.0", id, result: {} });
        }
      },
    });

    const ws = makeWs({ proto: 4, features: ["models"] });
    clients.add(ws);

    // Session 1: models domain authoritative
    await handlers.onControlFrame!(ws, { type: "session_new", requestId: "n1" });
    let ms = ws.frames.filter((f) => f.type === "models_state").pop() as unknown as ModelsStateFrame;
    expect(ms.availableModels.map((m) => m.modelId)).toEqual([
      "gemini-4-neon-high",
      "gemini-4-neon-xhigh",
      "gemini-3.8-flash",
      "gpt-6.2-sol[low]",
    ]);

    // session_set_model uses ACP session/set_model (NOT session/set_config_option)
    await handlers.onControlFrame!(ws, {
      type: "session_set_model",
      sessionId: "s-models",
      modelId: "gemini-3.8-flash",
      requestId: "sm-1",
    });
    expect(rpcCalls.some((c) => c.method === "session/set_model" && c.params.modelId === "gemini-3.8-flash")).toBe(true);
    expect(rpcCalls.some((c) => c.method === "session/set_config_option")).toBe(false);
    ms = ws.frames.filter((f) => f.type === "models_state").pop() as unknown as ModelsStateFrame;
    expect(ms.currentModelId).toBe("gemini-3.8-flash");
    expect(ms.requestId).toBe("sm-1");

    // Desktop-initiated config_option_update: <base>-<tier> match
    peers[0]!.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s-models",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "model", category: "model", currentValue: "gemini-4-neon" },
            { id: "thought_level", category: "thought_level", currentValue: "xhigh" },
          ],
        },
      },
    });
    await waitFor(() =>
      ws.frames.some((f) => f.type === "models_state" && f.currentModelId === "gemini-4-neon-xhigh"),
    );

    // Desktop-initiated config_option_update: <base>[<tier>] match
    peers[0]!.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s-models",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "model", category: "model", currentValue: "gpt-6.2-sol" },
            { id: "reasoning_effort", category: "reasoning_effort", currentValue: "low" },
          ],
        },
      },
    });
    await waitFor(() =>
      ws.frames.some((f) => f.type === "models_state" && f.currentModelId === "gpt-6.2-sol[low]"),
    );

    // Unmatched desktop config_option_update -> warn, keep last confirmed currentModelId, no corruption, no rebroadcast
    const frameCountBefore = ws.frames.length;
    peers[0]!.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s-models",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "model",
              category: "model",
              currentValue: "completely-unknown-model",
              options: [{ value: "corrupt", name: "Corrupt" }],
            },
          ],
        },
      },
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(ws.frames.length).toBe(frameCountBefore);
    expect(stderrWrites.some((line) => line.includes("completely-unknown-model"))).toBe(true);

    // Session 2: configOptions domain authoritative (when models absent)
    ws.frames.length = 0;
    rpcCalls.length = 0;
    await handlers.onControlFrame!(ws, { type: "session_new", requestId: "n2" });
    ms = ws.frames.filter((f) => f.type === "models_state").pop() as unknown as ModelsStateFrame;
    expect(ms.sessionId).toBe("s-cfg");
    expect(ms.currentModelId).toBe("cfg-a");
    expect(ms.availableModels).toEqual([
      { modelId: "cfg-a", name: "Cfg A", description: "Alpha" },
      { modelId: "cfg-b", name: "Cfg B", description: "Beta" },
    ]);

    await handlers.onControlFrame!(ws, {
      type: "session_set_model",
      sessionId: "s-cfg",
      modelId: "cfg-b",
      requestId: "sm-cfg",
    });
    expect(rpcCalls.some((c) =>
      c.method === "session/set_config_option" &&
      c.params.configId === "model_select" &&
      c.params.value === "cfg-b",
    )).toBe(true);
    expect(rpcCalls.some((c) => c.method === "session/set_model")).toBe(false);
    ms = ws.frames.filter((f) => f.type === "models_state").pop() as unknown as ModelsStateFrame;
    expect(ms.currentModelId).toBe("cfg-b");
    expect(ms.requestId).toBe("sm-cfg");

    // config_option_update read-back on configOptions domain
    peers[0]!.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s-cfg",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "model_select", category: "model", currentValue: "cfg-a" },
          ],
        },
      },
    });
    await waitFor(() =>
      ws.frames.some((f) => f.type === "models_state" && f.currentModelId === "cfg-a"),
    );
  });

  it("AV5: session_set_model fail-closed guards (turn_busy, sessionOpInFlight lock + drainQueue, invalid_model, -32601/-32602 under 'models')", async () => {
    let resolveSetModel!: () => void;
    let resolvePrompt!: () => void;
    let rpcErrorCode: number | null = null;
    const promptsReceived: string[] = [];

    const { manager, handlers } = createManagerHarness({
      onOutbound: (msg, peer) => {
        const id = msg.id as number | undefined;
        if (id === undefined) return;
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {} } });
          return;
        }
        if (msg.method === "session/new") {
          peer.emit({
            jsonrpc: "2.0",
            id,
            result: {
              sessionId: "s-guard",
              models: {
                currentModelId: "m-1",
                availableModels: [
                  { modelId: "m-1", name: "Model 1" },
                  { modelId: "m-2", name: "Model 2" },
                ],
              },
            },
          });
          return;
        }
        if (msg.method === "session/set_model") {
          if (rpcErrorCode !== null) {
            peer.emit({ jsonrpc: "2.0", id, error: { code: rpcErrorCode, message: "bad" } });
            return;
          }
          resolveSetModel = () => peer.emit({ jsonrpc: "2.0", id, result: {} });
          return;
        }
        if (msg.method === "session/prompt") {
          const blocks = ((msg.params as Record<string, unknown>).prompt ?? []) as Array<{ text?: string }>;
          promptsReceived.push(blocks.map((b) => b.text ?? "").join(""));
          resolvePrompt = () => peer.emit({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
        }
      },
    });

    // Socket with ONLY "models" (NOT "sessions") must receive session_error for session_set_model!
    const wsModelsOnly = makeWs({ proto: 4, features: ["models"] });
    clients.add(wsModelsOnly);

    await handlers.onControlFrame!(wsModelsOnly, { type: "session_new" });

    // 1. Missing modelId -> invalid_model under "models"
    await handlers.onControlFrame!(wsModelsOnly, {
      type: "session_set_model",
      modelId: "   ",
      requestId: "err-empty",
    });
    let err = wsModelsOnly.frames.find((f) => f.type === "session_error") as unknown as SessionErrorFrame;
    expect(err.action).toBe("session_set_model");
    expect(err.code).toBe("invalid_model");
    expect(err.requestId).toBe("err-empty");

    // 2. Unknown modelId not in availableModels -> invalid_model
    wsModelsOnly.frames.length = 0;
    await handlers.onControlFrame!(wsModelsOnly, {
      type: "session_set_model",
      modelId: "not-in-list",
      requestId: "err-unknown",
    });
    err = wsModelsOnly.frames.find((f) => f.type === "session_error") as unknown as SessionErrorFrame;
    expect(err.code).toBe("invalid_model");

    // 3. -32601 & -32602 -> invalid_model
    for (const code of [-32601, -32602]) {
      wsModelsOnly.frames.length = 0;
      rpcErrorCode = code;
      await handlers.onControlFrame!(wsModelsOnly, {
        type: "session_set_model",
        modelId: "m-2",
        requestId: `err-${code}`,
      });
      err = wsModelsOnly.frames.find((f) => f.type === "session_error") as unknown as SessionErrorFrame;
      expect(err.action).toBe("session_set_model");
      expect(err.code).toBe("invalid_model");
      expect(err.requestId).toBe(`err-${code}`);
    }
    rpcErrorCode = null;

    // 4. sessionOpInFlight lock blocks concurrent session_set_model with turn_busy, queues prompt, and drains in finally
    wsModelsOnly.frames.length = 0;
    const setModelPromise = handlers.onControlFrame!(wsModelsOnly, {
      type: "session_set_model",
      modelId: "m-2",
      requestId: "in-flight",
    });
    await waitFor(() => typeof resolveSetModel === "function");

    await handlers.onControlFrame!(wsModelsOnly, {
      type: "session_set_model",
      modelId: "m-1",
      requestId: "concurrent-sm",
    });
    err = wsModelsOnly.frames.find((f) => f.type === "session_error" && f.requestId === "concurrent-sm") as unknown as SessionErrorFrame;
    expect(err.code).toBe("turn_busy");

    // Inbound message queued while sessionOpInFlight
    await handlers.onInbound({ text: "queued-during-sm", meta: { sender_id: "u1" } });
    expect(promptsReceived).toEqual([]);

    resolveSetModel();
    await setModelPromise;
    await waitFor(() => promptsReceived.includes("queued-during-sm"));

    // 5. While turnBusy, session_set_model fails closed with turn_busy
    wsModelsOnly.frames.length = 0;
    await handlers.onControlFrame!(wsModelsOnly, {
      type: "session_set_model",
      modelId: "m-1",
      requestId: "during-turn",
    });
    err = wsModelsOnly.frames.find((f) => f.type === "session_error" && f.requestId === "during-turn") as unknown as SessionErrorFrame;
    expect(err.code).toBe("turn_busy");

    resolvePrompt();
    await waitFor(() => !manager.getStateSnapshot().turnBusy);
  });

  it("AV5/AV6: enforces models_state (<=100 preserving current) and commands_list (<=200, truncation, whitespace drop, slash strip, daemon dedupe)", async () => {
    const manyModels = Array.from({ length: 125 }, (_, i) => ({
      modelId: `model-${i}-${"x".repeat(130)}`,
      name: `Name ${i} ${"n".repeat(130)}`,
      description: `Desc ${i} ${"d".repeat(220)}`,
    }));
    const currentRawId = manyModels[120]!.modelId;
    const expectedCurrentId = currentRawId.slice(0, 128);

    const manyCommands = [
      { name: "help", description: "Host help collision" },
      { name: "/new", description: "Host new collision" },
      { name: "sessions", description: "Host sessions collision" },
      { name: "/resume", description: "Host resume collision" },
      { name: "cancel", description: "Host cancel collision" },
      { name: "/status", description: "Host status collision" },
      { name: "   ", description: "Blank" },
      { name: "has space", description: "Space" },
      { name: "has\nnewline", description: "Newline" },
      { name: "/", description: "Slash only" },
      ...Array.from({ length: 210 }, (_, i) => ({
        name: `/${"cmd_" + i}_${"k".repeat(70)}`,
        description: `Command ${i} ${"d".repeat(210)}`,
        input: { hint: `hint_${i}_${"h".repeat(90)}` },
      })),
    ];

    const { peers, handlers } = createManagerHarness({
      onOutbound: (msg, peer) => {
        const id = msg.id as number | undefined;
        if (id === undefined) return;
        if (msg.method === "initialize") {
          peer.emit({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {} } });
          return;
        }
        if (msg.method === "session/new") {
          peer.emit({
            jsonrpc: "2.0",
            id,
            result: {
              sessionId: "s-caps",
              models: {
                currentModelId: currentRawId,
                availableModels: manyModels,
              },
            },
          });
          peer.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-caps",
              update: {
                sessionUpdate: "available_commands_update",
                availableCommands: manyCommands,
              },
            },
          });
        }
      },
    });

    const ws = makeWs({ proto: 4, features: ["models", "commands"] });
    clients.add(ws);
    await handlers.onControlFrame!(ws, { type: "session_new" });
    await waitFor(() =>
      ws.frames.some((f) => f.type === "commands_list" && (f as unknown as CommandsListFrame).commands.length > 6),
    );

    const ms = ws.frames.find((f) => f.type === "models_state") as unknown as ModelsStateFrame;
    expect(ms.availableModels.length).toBe(100);
    expect(ms.currentModelId).toBe(expectedCurrentId);
    expect(ms.availableModels.some((m) => m.modelId === expectedCurrentId)).toBe(true);
    for (const m of ms.availableModels) {
      expect(m.modelId.length).toBeLessThanOrEqual(128);
      expect(m.name.length).toBeLessThanOrEqual(128);
      if (m.description !== undefined) {
        expect(m.description.length).toBeLessThanOrEqual(200);
      }
    }

    const cl = ws.frames.filter((f) => f.type === "commands_list").pop() as unknown as CommandsListFrame;
    expect(cl.commands.length).toBe(200);
    const daemonNames = ["help", "new", "sessions", "resume", "cancel", "status"];
    for (const dn of daemonNames) {
      const matches = cl.commands.filter((c) => c.name === dn);
      expect(matches.length).toBe(1);
      expect(matches[0]!.source).toBe("daemon");
    }
    // Appended at the tail
    expect(cl.commands.slice(-6).map((c) => c.name)).toEqual(daemonNames);
    for (const c of cl.commands) {
      expect(c.name.startsWith("/")).toBe(false);
      expect(/\s/.test(c.name)).toBe(false);
      expect(c.name.length).toBeLessThanOrEqual(64);
      if (c.description !== undefined) expect(c.description.length).toBeLessThanOrEqual(200);
      if (c.inputHint !== undefined) expect(c.inputHint.length).toBeLessThanOrEqual(80);
    }
    expect(peers.length).toBe(1);
  });

  it("AV5/AV6 E2E: startDaemon + real WebSocket routes session_set_model through http_bridge allowlist, isolates legacy WS, and passes raw /... to session/prompt", async () => {
    const logFile = join(tempHome, "e2e_mc.log");
    const daemon = await startDaemon({
      harness: "codex",
      port: 0,
      cwd: tempHome,
      enableMdns: false,
      enableDesktopNotifications: false,
      transportFactory: (_c, _a, opts) =>
        spawnAcpTransport(process.execPath, ["run", FAKE_MC_AGENT_PATH], {
          cwd: opts?.cwd,
          env: { FAKE_ACP_LOG_FILE: logFile, FAKE_ACP_MODELS_MODE: "models" },
        }),
    });
    cleanups.push(() => daemon.shutdown());

    const openWs = async () => {
      const frames: Array<Record<string, unknown>> = [];
      const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws?api_key=p2-mc-key`);
      cleanups.push(() => ws.close());
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = (e) => reject(e);
      });
      ws.onmessage = (ev) => {
        frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
      };
      return { ws, frames };
    };

    const legacy = await openWs();
    const p3 = await openWs();
    const p4 = await openWs();

    p3.ws.send(JSON.stringify({ type: "client_hello", proto: 3, features: ["sessions", "streaming"] }));
    p4.ws.send(
      JSON.stringify({
        type: "client_hello",
        proto: 4,
        features: ["sessions", "choices_settled", "streaming", "models", "commands"],
      }),
    );

    await waitFor(() => p4.frames.some((f) => f.type === "commands_list"));
    await waitFor(() => p3.frames.some((f) => f.type === "session_list"));

    // Create session -> models_state + commands_list arrive on p4 only
    p4.ws.send(JSON.stringify({ type: "session_new", requestId: "e2e-new" }));
    await waitFor(() => p4.frames.some((f) => f.type === "models_state" && f.sessionId === "mc-sess-1"));
    await waitFor(() =>
      p4.frames.some(
        (f) =>
          f.type === "commands_list" &&
          (f as unknown as CommandsListFrame).commands.some((c) => c.name === "compact"),
      ),
    );

    // Switch model via WS -> routed through http_bridge allowlist (NOT normalizeInboundPayload / session/prompt)
    expect(replyBuffer.size()).toBe(0);
    p4.ws.send(
      JSON.stringify({
        type: "session_set_model",
        sessionId: "mc-sess-1",
        modelId: "gemini-3.8-flash",
        requestId: "e2e-sm",
      }),
    );
    await waitFor(() =>
      p4.frames.some(
        (f) => f.type === "models_state" && f.requestId === "e2e-sm" && f.currentModelId === "gemini-3.8-flash",
      ),
    );
    expect(replyBuffer.size()).toBe(0);

    // Raw /compact command via POST / passes straight to session/prompt
    await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: {
        authorization: "Bearer p2-mc-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "/compact focus tests" }),
    });
    await waitFor(() =>
      p4.frames.some((f) => f.type === "reply" && f.text === "echo:/compact focus tests"),
    );

    // Verify legacy and proto:3 without models/commands never received models_state or commands_list
    expect(legacy.frames.some((f) => f.type === "models_state" || f.type === "commands_list")).toBe(false);
    expect(p3.frames.some((f) => f.type === "models_state" || f.type === "commands_list")).toBe(false);

    // Verify ACP log saw session/set_model and raw /compact prompt, and never saw session_set_model as a prompt
    const logLines = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(logLines.some((e) => e.event === "session/set_model" && e.modelId === "gemini-3.8-flash")).toBe(true);
    expect(logLines.some((e) => e.event === "session/prompt" && e.promptText === "/compact focus tests")).toBe(true);
    expect(logLines.some((e) => e.event === "session/prompt" && String(e.promptText).includes("session_set_model"))).toBe(false);
  });

  it("AV5 E2E: startDaemon with config_options domain + -32601 rejection over real WS", async () => {
    const logFile = join(tempHome, "e2e_cfg.log");
    const daemonCfg = await startDaemon({
      harness: "hermes",
      port: 0,
      cwd: tempHome,
      enableMdns: false,
      enableDesktopNotifications: false,
      transportFactory: (_c, _a, opts) =>
        spawnAcpTransport(process.execPath, ["run", FAKE_MC_AGENT_PATH], {
          cwd: opts?.cwd,
          env: { FAKE_ACP_LOG_FILE: logFile, FAKE_ACP_MODELS_MODE: "config_options" },
        }),
    });
    cleanups.push(() => daemonCfg.shutdown());

    const frames: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${daemonCfg.port}/ws?api_key=p2-mc-key`);
    cleanups.push(() => ws.close());
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
    ws.onmessage = (ev) => {
      frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    };

    ws.send(JSON.stringify({ type: "client_hello", proto: 4, features: ["models"] }));
    ws.send(JSON.stringify({ type: "session_new", requestId: "cfg-new" }));
    await waitFor(() => frames.some((f) => f.type === "models_state" && f.currentModelId === "cfg-model-a"));

    ws.send(
      JSON.stringify({
        type: "session_set_model",
        sessionId: "mc-sess-1",
        modelId: "cfg-model-b",
        requestId: "cfg-sm",
      }),
    );
    await waitFor(() =>
      frames.some((f) => f.type === "models_state" && f.requestId === "cfg-sm" && f.currentModelId === "cfg-model-b"),
    );

    const logLines = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(
      logLines.some(
        (e) => e.event === "session/set_config_option" && e.configId === "model" && e.value === "cfg-model-b",
      ),
    ).toBe(true);

    // Rejection (-32601) over real WS routes session_error under "models"
    const daemonReject = await startDaemon({
      harness: "agy",
      port: 0,
      cwd: tempHome,
      enableMdns: false,
      enableDesktopNotifications: false,
      transportFactory: (_c, _a, opts) =>
        spawnAcpTransport(process.execPath, ["run", FAKE_MC_AGENT_PATH], {
          cwd: opts?.cwd,
          env: { FAKE_ACP_MODELS_MODE: "models", FAKE_ACP_REJECT_SET_MODEL_CODE: "-32601" },
        }),
    });
    cleanups.push(() => daemonReject.shutdown());

    const rejFrames: Array<Record<string, unknown>> = [];
    const wsRej = new WebSocket(`ws://127.0.0.1:${daemonReject.port}/ws?api_key=p2-mc-key`);
    cleanups.push(() => wsRej.close());
    await new Promise<void>((resolve, reject) => {
      wsRej.onopen = () => resolve();
      wsRej.onerror = (e) => reject(e);
    });
    wsRej.onmessage = (ev) => {
      rejFrames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    };

    // Only declare "models" (NOT "sessions") to verify dynamic requiredFeature routing on session_error
    wsRej.send(JSON.stringify({ type: "client_hello", proto: 4, features: ["models"] }));
    wsRej.send(JSON.stringify({ type: "session_new", requestId: "rej-new" }));
    await waitFor(() => rejFrames.some((f) => f.type === "models_state" && f.sessionId === "mc-sess-1"));

    wsRej.send(
      JSON.stringify({
        type: "session_set_model",
        sessionId: "mc-sess-1",
        modelId: "gemini-3.8-flash",
        requestId: "rej-sm",
      }),
    );
    await waitFor(() =>
      rejFrames.some((f) => f.type === "session_error" && f.requestId === "rej-sm"),
    );
    const err = rejFrames.find((f) => f.type === "session_error" && f.requestId === "rej-sm") as unknown as SessionErrorFrame;
    expect(err.action).toBe("session_set_model");
    expect(err.code).toBe("invalid_model");
  });
});
