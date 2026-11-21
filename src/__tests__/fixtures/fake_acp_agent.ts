#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const logFile = process.env.FAKE_ACP_LOG_FILE;
const noResume = process.env.FAKE_ACP_NO_RESUME === "1";

if (process.env.FAKE_ACP_SPAWN_GRANDCHILD === "1") {
  // Spawn a grandchild in the same process group so SIGTERM pgid cleanup can be verified.
  spawn("sleep", ["60"], { stdio: "ignore" });
}

function logEvent(evt: Record<string, unknown>) {
  if (!logFile) return;
  appendFileSync(logFile, JSON.stringify(evt) + "\n", "utf8");
}

logEvent({
  event: "startup",
  pid: process.pid,
  hitl_daemon_session: process.env.HITL_DAEMON_SESSION ?? null,
});

interface SessionState {
  sessionId: string;
  cwd: string;
  mcpServers: Array<Record<string, unknown>>;
  title?: string;
  updatedAt: string;
}

const sessions = new Map<string, SessionState>();
let sessionSeq = 0;
let clientRpcSeq = 0;
const pendingClientResponses = new Map<number, (msg: Record<string, unknown>) => void>();
const cancelledSessions = new Set<string>();
const cancelWaiters = new Map<string, () => void>();

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

async function postMcp(
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

  if (!method) return;

  if (method === "session/cancel") {
    const sid = String(params.sessionId ?? "");
    cancelledSessions.add(sid);
    cancelWaiters.get(sid)?.();
    cancelWaiters.delete(sid);
    return;
  }

  if (id === undefined) return;

  if (method === "initialize") {
    logEvent({ event: "initialize", params });
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: noResume
            ? { list: {}, load: {} }
            : { resume: {}, list: {}, load: {} },
          promptCapabilities: { image: true },
        },
        agentInfo: { name: "fake-acp", version: "0.0.1" },
      },
    });
    return;
  }

  if (method === "session/new") {
    const sid = `fake-sess-${++sessionSeq}`;
    const state: SessionState = {
      sessionId: sid,
      cwd: String(params.cwd ?? "/tmp"),
      mcpServers: (params.mcpServers as Array<Record<string, unknown>>) ?? [],
      title: `Session ${sessionSeq}`,
      updatedAt: new Date().toISOString(),
    };
    sessions.set(sid, state);
    logEvent({ event: "session/new", sessionId: sid, params });
    send({ jsonrpc: "2.0", id, result: { sessionId: sid } });
    return;
  }

  if (method === "session/list") {
    logEvent({ event: "session/list" });
    send({
      jsonrpc: "2.0",
      id,
      result: {
        sessions: Array.from(sessions.values()).map((s) => ({
          sessionId: s.sessionId,
          cwd: s.cwd,
          title: s.title,
          updatedAt: s.updatedAt,
        })),
      },
    });
    return;
  }

  if (method === "session/resume" || method === "session/load") {
    const sid = String(params.sessionId ?? "");
    const existing = sessions.get(sid);
    const updated: SessionState = {
      sessionId: sid,
      cwd: String(params.cwd ?? existing?.cwd ?? "/tmp"),
      mcpServers: (params.mcpServers as Array<Record<string, unknown>>) ?? [],
      title: existing?.title ?? sid,
      updatedAt: new Date().toISOString(),
    };
    sessions.set(sid, updated);
    logEvent({ event: method, sessionId: sid, params });
    if (method === "session/load") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "REPLAYED_ON_LOAD " },
          },
        },
      });
    }
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "session/prompt") {
    const sid = String(params.sessionId ?? "");
    const blocks = (params.prompt as Array<Record<string, unknown>>) ?? [];
    const promptText = blocks
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("");
    logEvent({ event: "session/prompt", sessionId: sid, promptText, blocks });

    if (promptText.includes("__CRASH_NOW__")) {
      process.exit(42);
    }

    if (promptText.includes("__WAIT_CANCEL__")) {
      if (!cancelledSessions.has(sid)) {
        await new Promise<void>((resolve) => {
          cancelWaiters.set(sid, resolve);
        });
      }
      cancelledSessions.delete(sid);
      send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
      return;
    }

    if (promptText.includes("__PERM_TEST__")) {
      const resp = await sendClientRequest("session/request_permission", {
        sessionId: sid,
        toolCall: {
          toolCallId: "tc-perm-1",
          name: "bash",
          title: "Run shell command",
          kind: "execute",
          rawInput: { command: "echo hi" },
          status: "pending",
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      const outcome = (resp.result as { outcome?: Record<string, unknown> })?.outcome;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `PERM:${JSON.stringify(outcome)}` },
          },
        },
      });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      return;
    }

    if (promptText.startsWith("__MCP_CALL__:")) {
      const toolName = promptText.slice("__MCP_CALL__:".length).trim();
      const mcp = sessions.get(sid)?.mcpServers?.[0];
      if (!mcp) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "missing mcpServers" },
        });
        return;
      }

      const discoverResp = await postMcp(mcp, {
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {},
      });
      logEvent({ event: "mcp_discover", sessionId: sid, discoverResp });

      await postMcp(mcp, {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "fake-acp", version: "0.1.0" },
        },
      });

      const callResp = await postMcp(mcp, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "call_phone_tool",
          arguments: { name: toolName, arguments: { from: sid } },
          _meta: { "antigravity.google/conversation_id": sid },
        },
      });
      logEvent({ event: "mcp_call_phone_tool", sessionId: sid, callResp });

      const resultContent = (callResp.json.result as {
        content?: Array<{ text?: string }>;
      })?.content;
      const resultText = resultContent?.[0]?.text ?? JSON.stringify(callResp.json);

      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `MCP_RESULT:${resultText}` },
          },
        },
      });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      return;
    }

    if (promptText.startsWith("__REPLY_IMAGE__:")) {
      const msgId = promptText.slice("__REPLY_IMAGE__:".length).trim();
      const mcp = sessions.get(sid)?.mcpServers?.[0];
      if (mcp) {
        await postMcp(mcp, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "fake-acp", version: "0.1.0" },
          },
        });
        await postMcp(mcp, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "reply_to_hitl",
            arguments: {
              text: "interim image",
              message_id: msgId,
              attachments: [
                {
                  type: "image",
                  media_type: "image/png",
                  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                },
              ],
            },
            _meta: { "antigravity.google/conversation_id": sid },
          },
        });
      }
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      return;
    }

    if (promptText.includes("<workflow_delegation") && promptText.includes("__CALL_REPLY_FIRST__")) {
      const mcp = sessions.get(sid)?.mcpServers?.[0];
      if (mcp) {
        await postMcp(mcp, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "fake-acp", version: "0.1.0" },
          },
        });
        await postMcp(mcp, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "reply_to_hitl",
            arguments: {
              text: "interim progress",
              message_id: "X-DEL",
            },
            _meta: { "antigravity.google/conversation_id": sid },
          },
        });
      }
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "FINAL_DELEGATION_ANSWER" },
          },
        },
      });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      return;
    }

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `echo:${promptText}` },
        },
      },
    });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
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
        const msg = JSON.parse(line) as Record<string, unknown>;
        void handleRequest(msg);
      } catch {
        // ignore
      }
    }
    nl = buf.indexOf("\n");
  }
});
