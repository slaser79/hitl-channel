#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const logFile = process.env.FAKE_ACP_LOG_FILE;
const profile = (process.env.FAKE_HARNESS_PROFILE ?? "codex") as
  | "codex"
  | "hermes"
  | "stdio_only";
const hermesCapSysPrompt = process.env.FAKE_HERMES_CAP_SYS_PROMPT === "1";

function logEvent(evt: Record<string, unknown>) {
  if (!logFile) return;
  appendFileSync(logFile, JSON.stringify(evt) + "\n", "utf8");
}

logEvent({
  event: "startup",
  profile,
  pid: process.pid,
  hitl_daemon_session: process.env.HITL_DAEMON_SESSION ?? null,
});

interface SessionState {
  sessionId: string;
  cwd: string;
  mcpServers: Array<Record<string, unknown>>;
  title?: string;
  updatedAt: string;
  stdioProc?: StdioMcpClient;
}

const sessions = new Map<string, SessionState>();
let sessionSeq = 0;
let clientRpcSeq = 0;
const pendingClientResponses = new Map<number, (msg: Record<string, unknown>) => void>();

function send(obj: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendClientRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = ++clientRpcSeq;
  return new Promise((resolve) => {
    pendingClientResponses.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

class StdioMcpClient {
  private proc: ChildProcessWithoutNullStreams;
  private rpcSeq = 0;
  private buffer = "";
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();

  constructor(mcp: Record<string, unknown>) {
    const command = String(mcp.command);
    const args = Array.isArray(mcp.args) ? mcp.args.map(String) : [];
    const envPairs = Array.isArray(mcp.env)
      ? (mcp.env as Array<{ name: string; value: string }>)
      : [];
    const env: Record<string, string | undefined> = { ...process.env };
    for (const pair of envPairs) {
      env[pair.name] = pair.value;
    }
    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: env as NodeJS.ProcessEnv,
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf("\n");
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) {
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg.id !== undefined) {
              const resolver = this.pending.get(Number(msg.id));
              if (resolver) {
                this.pending.delete(Number(msg.id));
                resolver(msg);
              }
            }
          } catch {
            // ignore non-json
          }
        }
        idx = this.buffer.indexOf("\n");
      }
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.rpcSeq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params?: Record<string, unknown>) {
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n",
    );
  }

  close() {
    try {
      this.proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

async function postMcpHttp(
  mcp: Record<string, unknown>,
  rpcBody: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = String(mcp.url);
  const headersList = (mcp.headers as Array<{ name: string; value: string }>) ?? [];
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  for (const h of headersList) {
    headers[h.name] = h.value;
  }
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(rpcBody),
  });
  const text = await resp.text();
  return {
    status: resp.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function initSessionMcp(state: SessionState): Promise<void> {
  const mcp = state.mcpServers[0];
  if (!mcp) return;
  if ("command" in mcp && !("type" in mcp)) {
    state.stdioProc?.close();
    const client = new StdioMcpClient(mcp);
    state.stdioProc = client;
    await client.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: `fake-${profile}`, version: "0.1.0" },
    });
    client.notify("notifications/initialized");
    const toolsRes = await client.request("tools/list", {});
    const toolNames = (
      ((toolsRes.result as Record<string, unknown>)?.tools as Array<{ name: string }>) ?? []
    ).map((t) => t.name);
    logEvent({ event: "stdio_mcp_tools_list", sessionId: state.sessionId, toolNames });
    return;
  }

  await postMcpHttp(mcp, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: `fake-${profile}`, version: "0.1.0" },
    },
  });
  await postMcpHttp(mcp, { jsonrpc: "2.0", method: "notifications/initialized" });
  const toolsRes = await postMcpHttp(mcp, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const toolNames = (
    ((toolsRes.json.result as Record<string, unknown>)?.tools as Array<{ name: string }>) ?? []
  ).map((t) => t.name);
  logEvent({ event: "http_mcp_tools_list", sessionId: state.sessionId, toolNames });
}

async function callSessionMcp(
  state: SessionState,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const mcp = state.mcpServers[0];
  if (!mcp) return "NO_MCP";
  const rpc = {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000),
    method: "tools/call",
    params: { name, arguments: args },
  };
  let resultJson: Record<string, unknown>;
  if (state.stdioProc) {
    resultJson = await state.stdioProc.request("tools/call", rpc.params);
  } else {
    const res = await postMcpHttp(mcp, rpc);
    resultJson = res.json;
  }
  const content =
    ((resultJson.result as Record<string, unknown>)?.content as Array<{ text?: string }>) ??
    [];
  const rawText = content.map((c) => c.text ?? "").join("");
  try {
    const parsed = JSON.parse(rawText) as { success?: boolean; output?: unknown };
    if (parsed && parsed.success === true && typeof parsed.output === "string") {
      return parsed.output;
    }
  } catch {
    // Non-JSON text output
  }
  return rawText;
}

async function handleRequest(msg: Record<string, unknown>) {
  const id = msg.id as string | number | undefined;
  const method = msg.method as string | undefined;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  if (id !== undefined && !method && ("result" in msg || "error" in msg)) {
    const resolver = pendingClientResponses.get(Number(id));
    if (resolver) {
      pendingClientResponses.delete(Number(id));
      resolver(msg);
    }
    return;
  }

  if (method === "initialize") {
    logEvent({ event: "rpc", method, params });
    const capabilities =
      profile === "codex"
        ? {
            loadSession: true,
            sessionCapabilities: { resume: {}, list: {}, systemPrompt: {} },
            mcpCapabilities: { http: true, sse: false, acp: true },
            promptCapabilities: { image: true },
          }
        : profile === "stdio_only"
          ? {
              loadSession: true,
              sessionCapabilities: { resume: {}, list: {}, systemPrompt: {} },
              mcpCapabilities: { http: false, sse: false, acp: false },
              promptCapabilities: { image: true },
            }
          : {
              loadSession: true,
              sessionCapabilities: {
                resume: {},
                list: {},
                ...(hermesCapSysPrompt ? { systemPrompt: {} } : {}),
              },
              promptCapabilities: { image: true },
            };

    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: capabilities,
        agentInfo: { name: `fake-${profile}`, version: "0.1.0" },
      },
    });
    return;
  }

  if (method === "session/new") {
    const sessionId = `${profile}-sess-${++sessionSeq}`;
    const mcpServers = Array.isArray(params.mcpServers)
      ? (params.mcpServers as Array<Record<string, unknown>>)
      : [];
    const state: SessionState = {
      sessionId,
      cwd: String(params.cwd ?? process.cwd()),
      mcpServers,
      title: `Initial ${profile} title`,
      updatedAt: new Date().toISOString(),
    };
    sessions.set(sessionId, state);
    logEvent({
      event: "session_new",
      sessionId,
      cwd: state.cwd,
      mcpServers,
      systemPrompt: params.systemPrompt ?? null,
      _meta: params._meta ?? null,
    });
    await initSessionMcp(state);
    send({ jsonrpc: "2.0", id, result: { sessionId } });
    return;
  }

  if (method === "session/list") {
    const list = Array.from(sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt,
    }));
    send({ jsonrpc: "2.0", id, result: { sessions: list } });
    return;
  }

  if (method === "session/resume" || method === "session/load") {
    const sessionId = String(params.sessionId ?? "");
    const existing = sessions.get(sessionId);
    const mcpServers = Array.isArray(params.mcpServers)
      ? (params.mcpServers as Array<Record<string, unknown>>)
      : [];
    if (existing) {
      existing.mcpServers = mcpServers;
      await initSessionMcp(existing);
    }
    logEvent({
      event: method,
      sessionId,
      mcpServers,
      systemPrompt: params.systemPrompt ?? null,
    });

    if (profile === "hermes" || method === "session/load") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "HISTORICAL_REPLAY_CHUNK" },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "replay-tc-99",
            title: "mcp__hitl_channel__call_phone_tool",
            kind: "other",
          },
        },
      });
    }

    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "session/prompt") {
    const sessionId = String(params.sessionId ?? "");
    const state = sessions.get(sessionId);
    const promptBlocks = Array.isArray(params.prompt)
      ? (params.prompt as Array<{ type: string; text?: string }>)
      : [];
    logEvent({
      event: "session_prompt",
      sessionId,
      promptBlocks,
    });
    const combinedText = promptBlocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");

    if (combinedText.includes("hitl_tool") && state) {
      if (profile === "codex") {
        // Emit session/update tool_call with mcp.hitl-channel.<tool>, then send
        // bare request_permission with no name/title so toolCallId correlation fires.
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "codex-tc-1",
              kind: "execute",
              title: "mcp.hitl-channel.call_phone_tool",
              status: "pending",
              rawInput: {
                server: "hitl-channel",
                tool: "call_phone_tool",
                arguments: { name: "ping" },
              },
            },
          },
        });
        const permRes = await sendClientRequest("session/request_permission", {
          sessionId,
          toolCall: { toolCallId: "codex-tc-1", kind: "execute", status: "pending" },
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "Allow" },
            { optionId: "cancel", kind: "reject_once", name: "Cancel" },
          ],
        });
        logEvent({ event: "perm_outcome", tool: "hitl", outcome: permRes.result });
      } else if (profile === "hermes") {
        const permRes = await sendClientRequest("session/request_permission", {
          sessionId,
          toolCall: {
            toolCallId: "hermes-tc-1",
            title: "mcp__hitl_channel__call_phone_tool",
            kind: "other",
            rawInput: {},
          },
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
            { optionId: "deny", kind: "reject_once", name: "Deny" },
          ],
        });
        logEvent({ event: "perm_outcome", tool: "hitl", outcome: permRes.result });
      }

      const out = await callSessionMcp(state, "call_phone_tool", {
        name: "ping",
        arguments: {},
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `TOOL_OK:${out}` },
          },
        },
      });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      return;
    }

    if (combinedText.includes("shell") && state) {
      if (profile === "codex") {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "codex-cmd-1",
              kind: "execute",
              title: "Run command?",
              status: "pending",
              rawInput: { command: "echo hi" },
            },
          },
        });
        const permRes = await sendClientRequest("session/request_permission", {
          sessionId,
          toolCall: { toolCallId: "codex-cmd-1", kind: "execute", status: "pending" },
          options: [
            { optionId: "accept", kind: "allow_once", name: "Yes, proceed" },
            {
              optionId: "decline",
              kind: "reject_once",
              name: "No, continue without running it",
            },
          ],
        });
        const opt = (
          (permRes.result as Record<string, unknown>)?.outcome as Record<string, unknown>
        )?.optionId;
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `SHELL_DECISION:${opt}` },
            },
          },
        });
      } else {
        const permRes = await sendClientRequest("session/request_permission", {
          sessionId,
          toolCall: {
            toolCallId: "hermes-cmd-1",
            title: "ls -la",
            kind: "execute",
            rawInput: { command: "ls -la" },
          },
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
            { optionId: "deny", kind: "reject_once", name: "Deny" },
          ],
        });
        const opt = (
          (permRes.result as Record<string, unknown>)?.outcome as Record<string, unknown>
        )?.optionId;
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `SHELL_DECISION:${opt}` },
            },
          },
        });
      }
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      return;
    }

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `ECHO:${combinedText.slice(0, 80)}` },
        },
      },
    });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown method: ${method}` },
    });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      try {
        void handleRequest(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // ignore invalid json
      }
    }
    nl = buf.indexOf("\n");
  }
});

const cleanupAndExit = () => {
  for (const s of sessions.values()) {
    s.stdioProc?.close();
  }
  process.exit(0);
};
process.on("SIGTERM", cleanupAndExit);
process.on("SIGINT", cleanupAndExit);
