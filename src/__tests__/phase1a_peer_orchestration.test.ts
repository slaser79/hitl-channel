import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Bonjour } from "bonjour-service";
import type { AcpTransport } from "../acp_client.js";
import { AcpSessionManager } from "../acp_session_manager.js";
import { startDaemon } from "../daemon.js";
import {
  clients,
  correlator,
  replyBuffer,
} from "../http_bridge.js";
import { startMDNS, stopMDNS } from "../mdns.js";
import { getHitlToolDefinitions, registerHitlTools } from "../mcp_tools.js";
import type { HostRunEventFrame } from "../types.js";

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

describe("SPEC-HITL-APP-10832 Phase 1a — Peer Orchestration (AV1, AV1b, AV4, AV7, AV8, AV9, AV10, AV13)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
    clients.clear();
    replyBuffer.drain();
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(process.env.HOME!, "hitl-p1a-"));
    const prevChannelHome = process.env.HITL_CHANNEL_HOME;
    const prevApiKey = process.env.HITL_CHANNEL_API_KEY;
    process.env.HITL_CHANNEL_HOME = join(dir, "channels");
    process.env.HITL_CHANNEL_API_KEY = "p1a-test-key";
    cleanups.push(() => {
      if (prevChannelHome !== undefined) {
        process.env.HITL_CHANNEL_HOME = prevChannelHome;
      } else {
        delete process.env.HITL_CHANNEL_HOME;
      }
      if (prevApiKey !== undefined) {
        process.env.HITL_CHANNEL_API_KEY = prevApiKey;
      } else {
        delete process.env.HITL_CHANNEL_API_KEY;
      }
      rmSync(dir, { recursive: true, force: true });
    });
    return dir;
  }

  it("AV1: mDNS TXT includes capabilities with peerOrchestration and concurrentSessions", () => {
    const published: Array<Record<string, unknown>> = [];
    const pubSpy = spyOn(Bonjour.prototype, "publish").mockImplementation(
      (opts: unknown) => {
        published.push(opts as Record<string, unknown>);
        return { stop: () => {} } as unknown as ReturnType<Bonjour["publish"]>;
      },
    );
    const destSpy = spyOn(Bonjour.prototype, "destroy").mockImplementation(
      () => {},
    );
    cleanups.push(() => {
      stopMDNS();
      pubSpy.mockRestore();
      destSpy.mockRestore();
    });

    startMDNS(8790, "inst-mdns-1", "agy@Mac", {
      mode: "daemon",
      harness: "agy",
      capabilities: {
        sessions: true,
        streaming: true,
        choicesId: true,
        models: true,
        commands: true,
        peerOrchestration: true,
        concurrentSessions: true,
      },
    });
    const txt = published[0]!.txt as Record<string, string>;
    expect(JSON.parse(txt.capabilities!)).toEqual({
      sessions: true,
      streaming: true,
      choicesId: true,
      models: true,
      commands: true,
      peerOrchestration: true,
      concurrentSessions: true,
    });
  });

  it("AV1 & AV8: pre-mints mcpBindingId across HTTP & mcp-shim stdio for 2 concurrent workers + interactive chat, translates in daemon.ts, isolates worker tools/streams/session_list, and settles crash", async () => {
    const dir = makeTempDir();
    let sessSeq = 0;
    const mcpConfigsBySession = new Map<
      string,
      Array<Record<string, unknown>>
    >();
    const pendingPrompts = new Map<
      string,
      { id: number | string; peer: MockAcpTransport }
    >();
    const peers: MockAcpTransport[] = [];
    const cliScript = join(import.meta.dir, "..", "cli.ts");

    const daemon = await startDaemon({
      harness: "agy",
      port: 0,
      cwd: dir,
      mcpTransport: "http",
      enableMdns: false,
      enableDesktopNotifications: false,
      transportFactory: () => {
        const peer = new MockAcpTransport((msg, p) => {
          if (msg.method === "initialize") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {
                  loadSession: true,
                  sessionCapabilities: { resume: {}, list: {}, close: {} },
                },
              },
            });
          } else if (msg.method === "session/new") {
            const sid = `acp-sess-${++sessSeq}`;
            mcpConfigsBySession.set(
              sid,
              (msg.params as { mcpServers: Array<Record<string, unknown>> })
                .mcpServers,
            );
            p.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: sid } });
          } else if (msg.method === "session/list") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                sessions: Array.from(mcpConfigsBySession.keys()).map((id) => ({
                  sessionId: id,
                  cwd: dir,
                })),
              },
            });
          } else if (msg.method === "session/prompt") {
            const params = msg.params as {
              sessionId: string;
              prompt: Array<{ type: string; text?: string }>;
            };
            const sid = params.sessionId;
            const text = params.prompt.map((b) => b.text ?? "").join("");
            if (text.includes("__HOLD__")) {
              pendingPrompts.set(sid, {
                id: msg.id as number | string,
                peer: p,
              });
              // Emit chunks & tool_call on worker/interactive session
              p.emit({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: sid,
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: `tc-${sid}`,
                    name: "bash",
                    title: "Run check",
                    status: "in_progress",
                  },
                },
              });
              p.emit({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: sid,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: `chunk:${sid}` },
                  },
                },
              });
              return;
            }
            p.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: `done:${text}` },
                },
              },
            });
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { stopReason: "end_turn" },
            });
          }
        });
        peers.push(peer);
        return peer;
      },
    });
    cleanups.push(() => daemon.shutdown());

    const wsFrames: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${daemon.port}/ws?api_key=p1a-test-key`,
    );
    cleanups.push(() => ws.close());
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as Record<string, unknown>;
      wsFrames.push(f);
      if (f.type === "host_run_event" && f.event_id) {
        ws.send(JSON.stringify({ type: "host_run_ack", event_id: f.event_id }));
      }
      if (f.type === "tool_call_request") {
        ws.send(
          JSON.stringify({
            type: "tool_call_result",
            request_id: f.request_id,
            success: true,
            approval: "auto",
            output: `ok:${f.name}`,
            data: { seenOrigin: f.origin },
          }),
        );
      }
    };

    ws.send(
      JSON.stringify({
        type: "client_hello",
        proto: 4,
        features: ["sessions", "streaming", "choices_settled", "peer_orchestration"],
      }),
    );
    await waitFor(() => wsFrames.some((f) => f.type === "session_list"));

    // 1. Start interactive session & hold turn
    ws.send(JSON.stringify({ type: "session_new", requestId: "sn-int" }));
    await waitFor(() =>
      wsFrames.some((f) => f.type === "session_switched" && f.requestId === "sn-int"),
    );
    ws.send(JSON.stringify({ message: "__HOLD__ interactive" }));
    await waitFor(() => pendingPrompts.has("acp-sess-1"));

    // 2. Start 2 concurrent worker runs
    ws.send(
      JSON.stringify({
        type: "host_run_start",
        run_id: "wrun-1",
        prompt: "__HOLD__ w1",
        parent_run_id: "parent-0",
        episode_root_run_id: "root-0",
        dispatch_depth: 1,
        message_hop: 1,
      }),
    );
    ws.send(
      JSON.stringify({
        type: "host_run_start",
        run_id: "wrun-2",
        prompt: "__HOLD__ w2",
        parent_run_id: "parent-0",
        episode_root_run_id: "root-0",
        dispatch_depth: 2,
        message_hop: 2,
      }),
    );
    await waitFor(
      () => pendingPrompts.has("acp-sess-2") && pendingPrompts.has("acp-sess-3"),
    );

    // Idempotent duplicate host_run_start with same run_id does NOT spawn a 4th session
    ws.send(
      JSON.stringify({
        type: "host_run_start",
        run_id: "wrun-1",
        prompt: "__HOLD__ w1 duplicate",
        dispatch_depth: 1,
        message_hop: 1,
      }),
    );
    await waitFor(
      () =>
        wsFrames.filter(
          (f) => f.type === "host_run_ack" && f.run_id === "wrun-1",
        ).length >= 2,
    );
    expect(sessSeq).toBe(3);

    // 3. Verify worker stream/tool isolation from interactive streaming
    await new Promise((r) => setTimeout(r, 100));
    const streamDeltas = wsFrames.filter((f) => f.type === "stream_delta");
    const toolProgress = wsFrames.filter((f) => f.type === "tool_progress");
    expect(streamDeltas.every((d) => d.sessionId === "acp-sess-1")).toBe(true);
    expect(toolProgress.every((t) => t.sessionId === "acp-sess-1")).toBe(true);

    // 4. Verify pre-minted mcpBindingId attribution via HTTP (worker 1) and mcp-shim stdio (worker 2)
    const mcp1 = mcpConfigsBySession.get("acp-sess-2")![0] as {
      url: string;
      headers: Array<{ name: string; value: string }>;
    };
    const binding1 = mcp1.headers.find(
      (h) => h.name === "X-Hitl-Acp-Session-Id",
    )!.value;
    expect(binding1).not.toBe("acp-sess-2");
    expect(daemon.manager.resolveBoundAcpSessionId(binding1)).toBe("acp-sess-2");

    // HTTP call from worker 1: reply_to_hitl, present_choices_to_hitl, present_questions_to_hitl, dispatch_phone_agent
    const callHttpMcp = async (toolName: string, args: Record<string, unknown>) => {
      await fetch(mcp1.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${daemon.mcpToken}`,
          "x-hitl-acp-session-id": binding1,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0.1.0" },
          },
        }),
      });
      const resp = await fetch(mcp1.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${daemon.mcpToken}`,
          "x-hitl-acp-session-id": binding1,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        }),
      });
      return (await resp.json()) as Record<string, unknown>;
    };

    // Worker reply_to_hitl -> host_run_event(agent_message), NEVER interactive reply
    await callHttpMcp("reply_to_hitl", { text: "worker interim update" });
    await waitFor(() =>
      wsFrames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "wrun-1" &&
          f.kind === "agent_message" &&
          f.text === "worker interim update",
      ),
    );
    expect(
      wsFrames.some(
        (f) => f.type === "reply" && f.text === "worker interim update",
      ),
    ).toBe(false);

    // Worker present_choices_to_hitl -> host_run_event(permission_request), NEVER interactive choices
    await callHttpMcp("present_choices_to_hitl", {
      prompt: "Pick DB",
      choices: ["SQLite", "Postgres"],
    });
    await waitFor(() =>
      wsFrames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "wrun-1" &&
          f.kind === "permission_request" &&
          f.tool_name === "present_choices_to_hitl",
      ),
    );
    expect(wsFrames.some((f) => f.type === "choices")).toBe(false);

    // Worker present_questions_to_hitl -> host_run_event(permission_request), NEVER interactive questions_batch_request
    await callHttpMcp("present_questions_to_hitl", {
      questions: [
        { header: "Mode", question: "Fast or thorough?", choices: ["Fast", "Thorough"] },
      ],
    });
    await waitFor(() =>
      wsFrames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "wrun-1" &&
          f.kind === "permission_request" &&
          f.tool_name === "present_questions_to_hitl",
      ),
    );
    expect(wsFrames.some((f) => f.type === "questions_batch_request")).toBe(false);

    // Worker 2 via real mcp-shim stdio process using pre-minted binding2
    const mcp2 = mcpConfigsBySession.get("acp-sess-3")![0] as {
      url: string;
      headers: Array<{ name: string; value: string }>;
    };
    const binding2 = mcp2.headers.find(
      (h) => h.name === "X-Hitl-Acp-Session-Id",
    )!.value;
    const shim = spawn(
      process.execPath,
      ["run", cliScript, "mcp-shim", "--url", daemon.mcpUrl],
      {
        env: {
          ...process.env,
          HITL_MCP_SHIM_TOKEN: daemon.mcpToken,
          HITL_MCP_SHIM_SESSION_ID: binding2,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    cleanups.push(() => {
      try {
        shim.kill("SIGTERM");
      } catch {
        // ignore
      }
    });
    const shimLines: string[] = [];
    shim.stdout.setEncoding("utf8");
    shim.stdout.on("data", (chunk: string) => {
      for (const l of chunk.split("\n")) {
        if (l.trim()) shimLines.push(l.trim());
      }
    });
    shim.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "shim-test", version: "0.1.0" },
        },
      }) + "\n",
    );
    shim.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "dispatch_phone_agent",
          arguments: { agent_id: "researcher", input: "check logs" },
        },
      }) + "\n",
    );
    await waitFor(() =>
      wsFrames.some(
        (f) =>
          f.type === "tool_call_request" &&
          f.name === "dispatch_phone_agent" &&
          (f.origin as Record<string, unknown>)?.acp_session_id === "acp-sess-3",
      ),
    );
    const req2 = wsFrames.find(
      (f) =>
        f.type === "tool_call_request" &&
        f.name === "dispatch_phone_agent" &&
        (f.origin as Record<string, unknown>)?.acp_session_id === "acp-sess-3",
    )!;
    expect(req2.origin).toEqual({
      acp_session_id: "acp-sess-3",
      mode: "daemon",
      run_id: "wrun-2",
      parent_run_id: "parent-0",
      episode_root_run_id: "root-0",
      dispatch_depth: 2,
      message_hop: 2,
    });
    await waitFor(() => shimLines.length >= 2);

    // 5. Unbound daemon peer tool call FAILS CLOSED with missing_session_binding (never fallback)
    const unboundRes = await fetch(daemon.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${daemon.mcpToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "list_phone_agents", arguments: {} },
      }),
    });
    const unboundJson = (await unboundRes.json()) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
    };
    expect(unboundJson.result?.isError).toBe(true);
    expect(
      JSON.parse(unboundJson.result!.content![0]!.text).error,
    ).toBe("missing_session_binding");

    // 6. Complete interactive & worker 1; check session_list excludes workers
    const p1 = pendingPrompts.get("acp-sess-1")!;
    p1.peer.emit({
      jsonrpc: "2.0",
      id: p1.id,
      result: { stopReason: "end_turn" },
    });
    const p2 = pendingPrompts.get("acp-sess-2")!;
    p2.peer.emit({
      jsonrpc: "2.0",
      id: p2.id,
      result: { stopReason: "end_turn" },
    });
    await waitFor(() =>
      wsFrames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "wrun-1" &&
          f.kind === "completed",
      ),
    );
    const done1 = wsFrames.find(
      (f) =>
        f.type === "host_run_event" &&
        f.run_id === "wrun-1" &&
        f.kind === "completed",
    ) as unknown as HostRunEventFrame;
    expect(done1.output).toBe("chunk:acp-sess-2");

    ws.send(JSON.stringify({ type: "session_list_request", requestId: "sl-1" }));
    await waitFor(() =>
      wsFrames.some(
        (f) => f.type === "session_list" && f.requestId === "sl-1",
      ),
    );
    const slFrame = wsFrames.find(
      (f) => f.type === "session_list" && f.requestId === "sl-1",
    ) as { sessions: Array<{ sessionId: string }> };
    expect(slFrame.sessions.map((s) => s.sessionId)).toEqual(["acp-sess-1"]);

    // 7. Harness exit while wrun-2 is still active -> pinned failed(harness_exited)
    peers[0]!.crash(137);
    await waitFor(() =>
      wsFrames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "wrun-2" &&
          f.kind === "failed" &&
          f.reason === "harness_exited",
      ),
    );
    const fail2 = wsFrames.find(
      (f) =>
        f.type === "host_run_event" &&
        f.run_id === "wrun-2" &&
        f.kind === "failed",
    ) as unknown as HostRunEventFrame;
    expect(fail2.pinned).toBe(true);
  });

  it("AV1b: concurrentSessions:false and runtime busy rejection spill worker runs to pooled secondary AcpClient subprocesses (maxWorkerProcesses=2) without blocking interactive chat", async () => {
    const dir = makeTempDir();
    let spawnSeq = 0;
    let sessSeq = 0;
    const spawnedPeers: Array<{ idx: number; peer: MockAcpTransport }> = [];
    const sessionToSpawnIdx = new Map<string, number>();
    const activePromptOnSpawn = new Map<number, string>();
    const releaseWaiters = new Map<string, () => void>();
    const frames: Array<Record<string, unknown>> = [];
    const replies: string[] = [];

    // 1. Explicit concurrentSessions: false (e.g. hermes)
    const manager = new AcpSessionManager({
      harness: "hermes",
      defaultCwd: dir,
      mcpUrl: "http://127.0.0.1:41111/mcp",
      mcpToken: "tok",
      instanceId: "inst-av1b",
      concurrentSessions: false,
      maxWorkerProcesses: 2,
      transportFactory: () => {
        const idx = ++spawnSeq;
        const peer = new MockAcpTransport((msg, p) => {
          if (msg.method === "initialize") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: 1, agentCapabilities: {} },
            });
          } else if (msg.method === "session/new") {
            const sid = `p${idx}-s${++sessSeq}`;
            sessionToSpawnIdx.set(sid, idx);
            p.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: sid } });
          } else if (msg.method === "session/prompt") {
            const params = msg.params as {
              sessionId: string;
              prompt: Array<{ text?: string }>;
            };
            const sid = params.sessionId;
            const text = params.prompt.map((b) => b.text ?? "").join("");
            if (activePromptOnSpawn.has(idx)) {
              p.emit({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32000, message: "turn_busy: serialized" },
              });
              return;
            }
            activePromptOnSpawn.set(idx, sid);
            const finish = () => {
              activePromptOnSpawn.delete(idx);
              p.emit({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: sid,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: `ok:${idx}:${text}` },
                  },
                },
              });
              p.emit({
                jsonrpc: "2.0",
                id: msg.id,
                result: { stopReason: "end_turn" },
              });
            };
            if (text.includes("__WAIT__")) {
              releaseWaiters.set(sid, finish);
            } else {
              finish();
            }
          }
        });
        spawnedPeers.push({ idx, peer });
        return peer;
      },
      broadcastReplyFn: (text) => {
        replies.push(text);
      },
      broadcastToCapableFn: (_feature, frame) => {
        frames.push(frame);
        return 1;
      },
    });
    cleanups.push(() => manager.shutdown());

    const handlers = manager.getInboundHandlers();
    const ws = {
      readyState: 1,
      data: { features: new Set(["sessions", "streaming", "peer_orchestration"]) },
      send: () => 1,
    };

    // Hold interactive turn on primary spawn #1
    await handlers.onInbound({ text: "__WAIT__ interactive", meta: {} });
    await waitFor(() => releaseWaiters.size === 1);
    const intSid = Array.from(releaseWaiters.keys())[0]!;
    expect(sessionToSpawnIdx.get(intSid)).toBe(1);

    // Start 2 parallel worker runs -> MUST spawn secondary worker subprocesses #2 and #3 (maxWorkerProcesses=2)
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "w-fb-1",
      prompt: "__WAIT__ worker1",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "w-fb-2",
      prompt: "__WAIT__ worker2",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await waitFor(() => releaseWaiters.size === 3);

    const workerSids = Array.from(releaseWaiters.keys()).filter(
      (s) => s !== intSid,
    );
    expect(workerSids.map((s) => sessionToSpawnIdx.get(s)).sort()).toEqual([2, 3]);
    expect(spawnedPeers.length).toBe(3); // 1 primary + 2 pooled secondary workers

    // Crash secondary worker #2 -> worker fails, interactive #1 stays completely healthy!
    spawnedPeers[1]!.peer.crash(139);
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.kind === "failed" &&
          f.reason === "harness_exited",
      ),
    );

    // Complete interactive turn #1 and remaining worker
    for (const [sid, fn] of Array.from(releaseWaiters.entries())) {
      if (sid === intSid || sessionToSpawnIdx.get(sid) === 3) {
        fn();
        releaseWaiters.delete(sid);
      }
    }
    await waitFor(() => replies.some((r) => r.includes("ok:1:")));
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.kind === "completed",
      ),
    );
  });

  it("AV1b (runtime busy): concurrentSessions:true falls back to secondary subprocess when primary rejects parallel session/prompt as busy", async () => {
    const dir = makeTempDir();
    let spawnSeq = 0;
    let sessSeq = 0;
    const activeOnPrimary = { busy: false };
    let releasePrimary!: () => void;
    const frames: Array<Record<string, unknown>> = [];

    const manager = new AcpSessionManager({
      harness: "agy",
      defaultCwd: dir,
      mcpUrl: "http://127.0.0.1:41112/mcp",
      mcpToken: "tok",
      instanceId: "inst-av1b-rt",
      concurrentSessions: true,
      transportFactory: () => {
        const idx = ++spawnSeq;
        return new MockAcpTransport((msg, p) => {
          if (msg.method === "initialize") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: 1, agentCapabilities: {} },
            });
          } else if (msg.method === "session/new") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessionId: `rt-${idx}-${++sessSeq}` },
            });
          } else if (msg.method === "session/prompt") {
            const params = msg.params as {
              sessionId: string;
              prompt: Array<{ text?: string }>;
            };
            const text = params.prompt.map((b) => b.text ?? "").join("");
            if (idx === 1 && activeOnPrimary.busy) {
              p.emit({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32000, message: "concurrent turn busy" },
              });
              return;
            }
            if (idx === 1 && text.includes("__HOLD__")) {
              activeOnPrimary.busy = true;
              releasePrimary = () => {
                activeOnPrimary.busy = false;
                p.emit({
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { stopReason: "end_turn" },
                });
              };
              return;
            }
            p.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: `spilled:${idx}:${text}` },
                },
              },
            });
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { stopReason: "end_turn" },
            });
          }
        });
      },
      broadcastToCapableFn: (_f, frame) => {
        frames.push(frame);
        return 1;
      },
    });
    cleanups.push(() => manager.shutdown());

    const handlers = manager.getInboundHandlers();
    const ws = {
      readyState: 1,
      data: { features: new Set(["peer_orchestration"]) },
      send: () => 1,
    };
    await handlers.onInbound({ text: "__HOLD__", meta: {} });
    await waitFor(() => activeOnPrimary.busy);

    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "w-rt-spill",
      prompt: "do spilled work",
      dispatch_depth: 1,
      message_hop: 0,
    });

    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "w-rt-spill" &&
          f.kind === "completed",
      ),
    );
    const done = frames.find(
      (f) =>
        f.type === "host_run_event" &&
        f.run_id === "w-rt-spill" &&
        f.kind === "completed",
    ) as unknown as HostRunEventFrame;
    expect(done.output).toContain("spilled:2:");
    releasePrimary();
  });

  it("AV4 & AV9 & AV10: continuation (session reuse + host_session_expired), host_run_cancel + permission_response, host_run_message, and dispatch_depth>3 rejection", async () => {
    const dir = makeTempDir();
    let sessSeq = 0;
    const promptsReceived: Array<{ sid: string; text: string }> = [];
    const permOutcomes: Array<Record<string, unknown>> = [];
    const frames: Array<Record<string, unknown>> = [];
    const cancelHoldWaiters = new Map<string, () => void>();

    const manager = new AcpSessionManager({
      harness: "codex",
      defaultCwd: dir,
      mcpUrl: "http://127.0.0.1:41113/mcp",
      mcpToken: "tok",
      instanceId: "inst-av4",
      transportFactory: () =>
        new MockAcpTransport((msg, p) => {
          if (msg.method === "initialize") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {
                  loadSession: true,
                  sessionCapabilities: { close: {} },
                },
              },
            });
          } else if (msg.method === "session/new") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessionId: `cont-${++sessSeq}` },
            });
          } else if (msg.method === "session/load") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32001, message: "session_not_found" },
            });
          } else if (msg.method === "session/close") {
            p.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
          } else if (msg.method === "session/cancel") {
            const sid = (msg.params as { sessionId: string }).sessionId;
            cancelHoldWaiters.get(sid)?.();
            cancelHoldWaiters.delete(sid);
          } else if (msg.method === "session/prompt") {
            const params = msg.params as {
              sessionId: string;
              prompt: Array<{ text?: string }>;
            };
            const text = params.prompt.map((b) => b.text ?? "").join("");
            promptsReceived.push({ sid: params.sessionId, text });
            if (text.includes("__CANCEL_ME__")) {
              cancelHoldWaiters.set(params.sessionId, () => {
                p.emit({
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { stopReason: "cancelled" },
                });
              });
              return;
            }
            if (text.includes("__ASK_PERM__")) {
              // Emit permission_request from ACP
              p.emit({
                jsonrpc: "2.0",
                id: 7001,
                method: "session/request_permission",
                params: {
                  sessionId: params.sessionId,
                  toolCall: { toolCallId: "tc-p", name: "edit_file" },
                  options: [
                    { optionId: "allow_once", name: "Allow", kind: "allow_once" },
                    { optionId: "deny", name: "Deny", kind: "reject_once" },
                  ],
                },
              });
              // Complete after response arrives
              const checkInterval = setInterval(() => {
                const resp = p.sent.find((m) => m.id === 7001);
                if (resp) {
                  clearInterval(checkInterval);
                  permOutcomes.push(resp.result as Record<string, unknown>);
                  p.emit({
                    jsonrpc: "2.0",
                    method: "session/update",
                    params: {
                      sessionId: params.sessionId,
                      update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: "perm-done" },
                      },
                    },
                  });
                  p.emit({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: { stopReason: "end_turn" },
                  });
                }
              }, 10);
              return;
            }
            p.emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: `reply:${text}` },
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
    const handlers = manager.getInboundHandlers();
    const ws = {
      readyState: 1,
      data: { features: new Set(["peer_orchestration"]) },
      send: () => 1,
    };

    // 1. Permission round-trip on worker run
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "r-perm",
      prompt: "__ASK_PERM__",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "r-perm" &&
          f.kind === "permission_request",
      ),
    );
    const permEv = frames.find(
      (f) =>
        f.type === "host_run_event" &&
        f.run_id === "r-perm" &&
        f.kind === "permission_request",
    ) as unknown as HostRunEventFrame;
    await handlers.onControlFrame!(ws, {
      type: "host_run_message",
      run_id: "r-perm",
      acp_session_id: "cont-1",
      event_id: "hm-perm-1",
      kind: "permission_response",
      choices_id: permEv.choices_id,
      option_id: "allow_once",
    });
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "r-perm" &&
          f.kind === "completed",
      ),
    );
    expect(permOutcomes[0]).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });

    // 2. Follow-up host_run_message delivers into cont-1
    await handlers.onControlFrame!(ws, {
      type: "host_run_message",
      run_id: "r-perm",
      acp_session_id: "cont-1",
      event_id: "hm-msg-1",
      kind: "agent_message",
      text: "follow up note",
      sender_agent_id: "lead-1",
      sender_name: "Lead",
      message_hop: 2,
    });
    await waitFor(() =>
      promptsReceived.some(
        (p) => p.sid === "cont-1" && p.text.includes("follow up note"),
      ),
    );
    expect(manager.getWorkerContext("cont-1")?.messageHop).toBe(2);

    // 3. Continue settled run on same acp_session_id ("cont-1")
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "r-cont",
      acp_session_id: "cont-1",
      prompt: "continue work",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "r-cont" &&
          f.kind === "completed",
      ),
    );
    expect(sessSeq).toBe(1); // Reused cont-1 without creating a new session

    // 4. Cancel active worker run via host_run_cancel
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "r-cancel",
      prompt: "__CANCEL_ME__",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await waitFor(() => cancelHoldWaiters.size > 0);
    await handlers.onControlFrame!(ws, {
      type: "host_run_cancel",
      run_id: "r-cancel",
      reason: "user_stop",
    });
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "r-cancel" &&
          f.kind === "cancelled" &&
          f.reason === "user_stop",
      ),
    );

    // 5. Missing/closed acp_session_id continuation fails with host_session_expired
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "r-expired",
      acp_session_id: "nonexistent-sess",
      prompt: "resume missing",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "r-expired" &&
          f.kind === "failed" &&
          f.reason === "host_session_expired",
      ),
    );

    // 6. dispatch_depth > 3 rejects deterministically
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "r-depth-fail",
      prompt: "too deep",
      dispatch_depth: 4,
      message_hop: 0,
    });
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "r-depth-fail" &&
          f.kind === "failed" &&
          f.reason === "max_dispatch_depth_exceeded",
      ),
    );
  });

  it("AV7 & AV8: channel mode executes 4 peer tools with origin.acp_session_id=null, refuses message_phone_agent, and raw call_phone_tool refuses dispatch_agent/message_agent; phone_run_wake enqueues & ACKs", async () => {
    const dir = makeTempDir();

    // 1. Channel mode MCP tools
    const channelMcp = new Server(
      { name: "hitl-channel", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    registerHitlTools(channelMcp, { mode: "channel" });
    const listHandler = (channelMcp as any)._requestHandlers.get("tools/list");
    const callHandler = (channelMcp as any)._requestHandlers.get("tools/call");

    const listed = await listHandler({ method: "tools/list", params: {} });
    const peerNames = (listed.tools as Array<{ name: string }>)
      .map((t) => t.name)
      .filter((n) =>
        [
          "list_phone_agents",
          "run_phone_agent",
          "dispatch_phone_agent",
          "message_phone_agent",
          "get_phone_run",
        ].includes(n),
      );
    expect(peerNames).toEqual([
      "list_phone_agents",
      "run_phone_agent",
      "dispatch_phone_agent",
      "message_phone_agent",
      "get_phone_run",
    ]);

    // message_phone_agent refused in channel mode
    const msgErr = await callHandler({
      method: "tools/call",
      params: {
        name: "message_phone_agent",
        arguments: { to: "parent", text: "hi" },
      },
    });
    expect(msgErr.isError).toBe(true);
    expect(JSON.parse(msgErr.content[0].text).error).toBe(
      "unsupported_in_channel_mode",
    );

    // Raw call_phone_tool refuses dispatch_agent and message_agent
    for (const blocked of ["dispatch_agent", "message_agent"]) {
      const res = await callHandler({
        method: "tools/call",
        params: {
          name: "call_phone_tool",
          arguments: { name: blocked, arguments: {} },
        },
      });
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).error).toBe("use_typed_peer_tool");
    }

    // Channel mode dispatch_phone_agent & get_phone_run attach origin.acp_session_id = null, mode = "channel"
    const sentFrames: Array<Record<string, unknown>> = [];
    const mockWs = {
      readyState: 1,
      send: (raw: string) => {
        const frame = JSON.parse(raw) as Record<string, unknown>;
        sentFrames.push(frame);
        if (frame.type === "tool_call_request") {
          queueMicrotask(() => {
            correlator.resolve(String(frame.request_id), {
              type: "tool_call_result",
              request_id: frame.request_id,
              success: true,
              approval: "user_approved",
              output: JSON.stringify({ run_id: "pr-1", status: "queued" }),
            });
          });
        }
        return raw.length;
      },
    } as any;
    clients.add(mockWs);

    const chDispatch = await callHandler({
      method: "tools/call",
      params: {
        name: "dispatch_phone_agent",
        arguments: { agent_id: "researcher", input: "find docs" },
      },
    });
    expect(chDispatch.isError).toBeUndefined();
    expect(sentFrames[0]!.origin).toEqual({
      acp_session_id: null,
      mode: "channel",
    });

    // 2. Daemon mode: fails closed when requestAcpSessionId missing even if getFallbackAcpSessionId is provided
    const daemonMcpNoBind = new Server(
      { name: "hitl-channel", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    registerHitlTools(daemonMcpNoBind, {
      mode: "daemon",
      requestAcpSessionId: null,
      getFallbackAcpSessionId: () => "fallback-should-never-be-used",
    });
    const unboundCall = (daemonMcpNoBind as any)._requestHandlers.get(
      "tools/call",
    );
    const bindErr = await unboundCall({
      method: "tools/call",
      params: {
        name: "dispatch_phone_agent",
        arguments: { agent_id: "researcher", input: "x" },
      },
    });
    expect(bindErr.isError).toBe(true);
    expect(JSON.parse(bindErr.content[0].text).error).toBe(
      "missing_session_binding",
    );

    // 3. phone_run_wake delivers <phone_agent_event> FIFO into target acpSessionId and sends host_run_ack
    const wakePrompts: Array<{ sid: string; text: string }> = [];
    const manager = new AcpSessionManager({
      harness: "agy",
      defaultCwd: dir,
      mcpUrl: "http://127.0.0.1:41114/mcp",
      mcpToken: "tok",
      instanceId: "inst-wake",
      transportFactory: () =>
        new MockAcpTransport((msg, p) => {
          if (msg.method === "initialize") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: 1, agentCapabilities: {} },
            });
          } else if (msg.method === "session/new") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessionId: "wake-sess-1" },
            });
          } else if (msg.method === "session/prompt") {
            const params = msg.params as {
              sessionId: string;
              prompt: Array<{ text?: string }>;
            };
            wakePrompts.push({
              sid: params.sessionId,
              text: params.prompt.map((b) => b.text ?? "").join(""),
            });
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { stopReason: "end_turn" },
            });
          }
        }),
      broadcastToCapableFn: () => 1,
    });
    cleanups.push(() => manager.shutdown());

    const wsAckFrames: Array<Record<string, unknown>> = [];
    const wakeWs = {
      readyState: 1,
      data: { features: new Set(["peer_orchestration"]) },
      send: (d: string) => {
        wsAckFrames.push(JSON.parse(d) as Record<string, unknown>);
        return d.length;
      },
    };
    const handlers = manager.getInboundHandlers();
    await handlers.onControlFrame!(wakeWs, {
      type: "host_run_start",
      run_id: "w-for-wake",
      prompt: "initial work",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await waitFor(() => wakePrompts.length === 1);

    await handlers.onControlFrame!(wakeWs, {
      type: "phone_run_wake",
      event_id: "pw-1",
      run_id: "phone-child-1",
      acp_session_id: "wake-sess-1",
      status: "completed",
      output: "research complete",
      sender_agent_id: "researcher",
      sender_name: "Researcher",
      message_hop: 2,
    });
    await waitFor(() => wakePrompts.length === 2);
    expect(wakePrompts[1]!.sid).toBe("wake-sess-1");
    expect(wakePrompts[1]!.text).toContain("<phone_agent_event");
    expect(wakePrompts[1]!.text).toContain('run_id="phone-child-1"');
    expect(wakePrompts[1]!.text).toContain("research complete");
    expect(
      wsAckFrames.some(
        (f) =>
          f.type === "host_run_ack" &&
          f.event_id === "pw-1" &&
          f.acp_session_id === "wake-sess-1",
      ),
    ).toBe(true);
  });

  it("AV13: maxWorkerSessions=8 and workerIdleTtlMs=30m evict oldest idle worker sessions via capability-gated session/close without disturbing active runs or interactive session", async () => {
    const dir = makeTempDir();
    let now = 10_000_000;
    let sessSeq = 0;
    const closedSessions: string[] = [];
    const frames: Array<Record<string, unknown>> = [];
    const activePromptHolders = new Map<string, () => void>();

    const manager = new AcpSessionManager({
      harness: "agy",
      defaultCwd: dir,
      mcpUrl: "http://127.0.0.1:41115/mcp",
      mcpToken: "tok",
      instanceId: "inst-av13",
      maxWorkerSessions: 8,
      workerIdleTtlMs: 30 * 60 * 1000,
      nowMs: () => now,
      transportFactory: () =>
        new MockAcpTransport((msg, p) => {
          if (msg.method === "initialize") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {
                  sessionCapabilities: { close: {} },
                },
              },
            });
          } else if (msg.method === "session/new") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessionId: `gc-sess-${++sessSeq}` },
            });
          } else if (msg.method === "session/close") {
            closedSessions.push(
              String((msg.params as { sessionId: string }).sessionId),
            );
            p.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
          } else if (msg.method === "session/prompt") {
            const params = msg.params as {
              sessionId: string;
              prompt: Array<{ text?: string }>;
            };
            const text = params.prompt.map((b) => b.text ?? "").join("");
            if (text.includes("__ACTIVE__")) {
              activePromptHolders.set(params.sessionId, () => {
                p.emit({
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { stopReason: "end_turn" },
                });
              });
              return;
            }
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

    const handlers = manager.getInboundHandlers();
    const ws = {
      readyState: 1,
      data: { features: new Set(["sessions", "peer_orchestration"]) },
      send: () => 1,
    };

    // Create interactive session (gc-sess-1)
    await handlers.onControlFrame!(ws, {
      type: "session_new",
      requestId: "sn-int-13",
    });
    await waitFor(() => manager.getStateSnapshot().activeSessionId === "gc-sess-1");

    // Start 8 worker sessions: 1st is active/held, 2..8 complete quickly
    for (let i = 1; i <= 8; i++) {
      now += 1000;
      await handlers.onControlFrame!(ws, {
        type: "host_run_start",
        run_id: `gc-run-${i}`,
        prompt: i === 1 ? "__ACTIVE__" : `work-${i}`,
        dispatch_depth: 1,
        message_hop: 0,
      });
      if (i > 1) {
        await waitFor(() =>
          frames.some(
            (f) =>
              f.type === "host_run_event" &&
              f.run_id === `gc-run-${i}` &&
              f.kind === "completed",
          ),
        );
      }
    }
    expect(manager.getStateSnapshot().workerSessionCount).toBe(8);

    // 9th worker session -> must evict oldest COMPLETED idle worker (gc-sess-3, which was gc-run-2), NOT active gc-sess-2 (gc-run-1)!
    now += 1000;
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "gc-run-9",
      prompt: "work-9",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "gc-run-9" &&
          f.kind === "completed",
      ),
    );
    expect(closedSessions).toEqual(["gc-sess-3"]);
    expect(manager.getStateSnapshot().workerSessionCount).toBe(8);
    expect(manager.getStateSnapshot().activeSessionId).toBe("gc-sess-1");

    // Attempting to continue evicted gc-sess-3 returns host_session_expired
    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      run_id: "gc-run-cont-evicted",
      acp_session_id: "gc-sess-3",
      prompt: "continue evicted",
      dispatch_depth: 1,
      message_hop: 0,
    });
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "gc-run-cont-evicted" &&
          f.kind === "failed" &&
          f.reason === "host_session_expired",
      ),
    );

    // Advance clock past 30m TTL -> evicts all 7 idle workers via session/close, leaving active gc-sess-2 + interactive gc-sess-1 untouched
    now += 31 * 60 * 1000;
    const evictedByTtl = await manager.runWorkerGc();
    expect(evictedByTtl).toBe(7);
    expect(manager.getStateSnapshot().workerSessionCount).toBe(1);
    expect(closedSessions).not.toContain("gc-sess-1");
    expect(closedSessions).not.toContain("gc-sess-2");

    // Finish active worker
    activePromptHolders.get("gc-sess-2")!();
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "host_run_event" &&
          f.run_id === "gc-run-1" &&
          f.kind === "completed",
      ),
    );
  });

  it("AV1 (server.ts channel mode): GET /instance advertises peerOrchestration=false and concurrentSessions=false", async () => {
    const dir = makeTempDir();
    const port = await getFreePort();
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.BUN_ENV;
    env.NODE_ENV = "production";
    env.HITL_CHANNEL_PORT = String(port);
    env.HITL_CHANNEL_IDENTITY_FILE = join(dir, "ch-identity.json");

    const child = spawn(process.execPath, ["run", "src/server.ts"], {
      cwd: join(import.meta.dir, "..", ".."),
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanups.push(() => {
      try {
        child.stdin.end();
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    });

    let inst: Record<string, unknown> | null = null;
    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/instance`);
        if (res.status === 200) {
          inst = (await res.json()) as Record<string, unknown>;
          return true;
        }
        return false;
      } catch {
        return false;
      }
    });
      expect(inst!.capabilities).toEqual({
      sessions: false,
      streaming: false,
      choicesId: true,
      models: false,
      commands: false,
      peerOrchestration: false,
      concurrentSessions: false,
    });
  });

  it("echoes host_run_ack with event_id for host_run_start, host_run_message (initial + duplicate), and host_run_cancel", async () => {
    const dir = makeTempDir();
    const mgr = new AcpSessionManager({
      harness: "agy",
      defaultCwd: dir,
      mcpUrl: "http://127.0.0.1:41115/mcp",
      mcpToken: "tok",
      instanceId: "inst-ack",
      workerOutboxPath: join(dir, "outbox.jsonl"),
      transportFactory: () =>
        new MockAcpTransport((msg, p) => {
          if (msg.method === "initialize") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: 1, agentCapabilities: {} },
            });
          } else if (msg.method === "session/new") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessionId: "ws-ack-1" },
            });
          } else if (msg.method === "session/prompt") {
            p.emit({
              jsonrpc: "2.0",
              id: msg.id,
              result: { stopReason: "end_turn" },
            });
          } else if (msg.method === "session/cancel") {
            p.emit({ jsonrpc: "2.0", id: msg.id, result: {} });
          }
        }),
    });
    cleanups.push(() => mgr.shutdown());

    const frames: Record<string, unknown>[] = [];
    const ws = {
      readyState: 1,
      data: { features: new Set(["peer_orchestration"]) },
      send: (raw: string) => {
        frames.push(JSON.parse(raw) as Record<string, unknown>);
        return 1;
      },
    };
    const handlers = mgr.getInboundHandlers();

    await handlers.onControlFrame!(ws, {
      type: "host_run_start",
      event_id: "ev-start-1",
      run_id: "run-ack-1",
      prompt: "inspect repo",
      dispatch_depth: 1,
      message_hop: 0,
    });
    expect(
      frames.some(
        (f) =>
          f.type === "host_run_ack" &&
          f.event_id === "ev-start-1" &&
          f.run_id === "run-ack-1" &&
          f.acp_session_id === "ws-ack-1",
      ),
    ).toBe(true);

    frames.length = 0;
    await handlers.onControlFrame!(ws, {
      type: "host_run_message",
      event_id: "ev-msg-1",
      run_id: "run-ack-1",
      acp_session_id: "ws-ack-1",
      kind: "agent_message",
      text: "hello",
      message_hop: 1,
    });
    expect(
      frames.filter(
        (f) =>
          f.type === "host_run_ack" &&
          f.event_id === "ev-msg-1" &&
          f.run_id === "run-ack-1",
      ),
    ).toHaveLength(1);

    // Duplicate event_id replays idempotent host_run_ack
    frames.length = 0;
    await handlers.onControlFrame!(ws, {
      type: "host_run_message",
      event_id: "ev-msg-1",
      run_id: "run-ack-1",
      acp_session_id: "ws-ack-1",
      kind: "agent_message",
      text: "hello",
      message_hop: 1,
    });
    expect(
      frames.filter(
        (f) =>
          f.type === "host_run_ack" &&
          f.event_id === "ev-msg-1" &&
          f.run_id === "run-ack-1",
      ),
    ).toHaveLength(1);

    frames.length = 0;
    await handlers.onControlFrame!(ws, {
      type: "host_run_cancel",
      event_id: "ev-cancel-1",
      run_id: "run-ack-1",
      acp_session_id: "ws-ack-1",
      reason: "user_cancelled",
    });
    expect(
      frames.some(
        (f) =>
          f.type === "host_run_ack" &&
          f.event_id === "ev-cancel-1" &&
          f.run_id === "run-ack-1",
      ),
    ).toBe(true);
  });
});
