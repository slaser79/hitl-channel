#!/usr/bin/env bun
import { appendFileSync } from "node:fs";

const logFile = process.env.FAKE_ACP_LOG_FILE;
const mode = process.env.FAKE_ACP_MODELS_MODE ?? "models"; // "models" | "config_options" | "none"
const rejectSetModelCode = process.env.FAKE_ACP_REJECT_SET_MODEL_CODE
  ? Number(process.env.FAKE_ACP_REJECT_SET_MODEL_CODE)
  : null;

function logEvent(evt: Record<string, unknown>) {
  if (!logFile) return;
  appendFileSync(logFile, JSON.stringify(evt) + "\n", "utf8");
}

function send(obj: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let sessionSeq = 0;
const sessions = new Map<string, { cwd: string; title: string; updatedAt: string }>();

function makeSessionMetadata(currentModelId?: string) {
  if (mode === "none") {
    return {};
  }
  if (mode === "config_options") {
    return {
      configOptions: [
        {
          id: "model",
          category: "model",
          name: "Model",
          type: "select",
          currentValue: currentModelId ?? "cfg-model-a",
          options: [
            { value: "cfg-model-a", name: "Config Model A", description: "Fast default" },
            { value: "cfg-model-b", name: "Config Model B", description: "Deep reasoning" },
          ],
        },
      ],
    };
  }
  return {
    models: {
      currentModelId: currentModelId ?? "gemini-4-neon-high",
      availableModels: [
        { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)", description: "Balanced" },
        { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)", description: "Max thinking" },
        { modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash", description: "Fast" },
        { modelId: "gpt-6.2-sol[low]", name: "GPT-6.2 Sol (Low)", description: "Low reasoning" },
      ],
    },
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: "gemini-4-neon",
        options: [
          { value: "gemini-4-neon", name: "Gemini 4 Neon" },
          { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        ],
      },
      {
        id: "thought_level",
        category: "thought_level",
        currentValue: "high",
        options: [
          { value: "high", name: "High" },
          { value: "xhigh", name: "XHigh" },
        ],
      },
    ],
  };
}

function emitAvailableCommands(sessionId: string) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "compact", description: "Compact conversation history", input: { hint: "[focus]" } },
          { name: "/plan", description: "Enter planning mode", input: null },
          { name: "status", description: "Host status collision should be deduped" },
          { name: "bad name", description: "Has whitespace - drop" },
          { name: "bad\nline", description: "Has newline - drop" },
          { name: "", description: "Empty name - drop" },
        ],
      },
    },
  });
}

async function handleRequest(msg: Record<string, unknown>) {
  const id = msg.id as string | number | undefined;
  const method = msg.method as string | undefined;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  if (!method || id === undefined) return;

  if (method === "initialize") {
    logEvent({ event: "initialize", params });
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, list: {}, load: {} },
          promptCapabilities: { image: true },
        },
        agentInfo: { name: "fake-models-acp", version: "0.0.1" },
      },
    });
    return;
  }

  if (method === "session/new") {
    const sid = `mc-sess-${++sessionSeq}`;
    sessions.set(sid, {
      cwd: String(params.cwd ?? "/tmp"),
      title: `MC Session ${sessionSeq}`,
      updatedAt: new Date().toISOString(),
    });
    logEvent({ event: "session/new", sessionId: sid, params });
    send({
      jsonrpc: "2.0",
      id,
      result: {
        sessionId: sid,
        ...makeSessionMetadata(),
      },
    });
    emitAvailableCommands(sid);
    return;
  }

  if (method === "session/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        sessions: Array.from(sessions.entries()).map(([sessionId, s]) => ({
          sessionId,
          cwd: s.cwd,
          title: s.title,
          updatedAt: s.updatedAt,
        })),
      },
    });
    return;
  }

  if (method === "session/load" || method === "session/resume") {
    const sid = String(params.sessionId ?? "");
    logEvent({ event: method, sessionId: sid, params });
    emitAvailableCommands(sid);
    if (method === "session/load") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "REPLAYED_CHUNK" },
          },
        },
      });
    }
    send({
      jsonrpc: "2.0",
      id,
      result: makeSessionMetadata(mode === "config_options" ? "cfg-model-b" : "gemini-3.8-flash"),
    });
    return;
  }

  if (method === "session/set_model") {
    const sid = String(params.sessionId ?? "");
    const modelId = String(params.modelId ?? "");
    logEvent({ event: "session/set_model", sessionId: sid, modelId });
    if (rejectSetModelCode !== null) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: rejectSetModelCode, message: `Rejected model ${modelId}` },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "model", category: "model", currentValue: modelId },
          ],
        },
      },
    });
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "session/set_config_option") {
    const sid = String(params.sessionId ?? "");
    const configId = String(params.configId ?? "");
    const value = String(params.value ?? "");
    logEvent({ event: "session/set_config_option", sessionId: sid, configId, value });
    if (rejectSetModelCode !== null) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: rejectSetModelCode, message: `Rejected config option ${value}` },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: configId,
              category: "model",
              currentValue: value,
              options: [
                { value: "cfg-model-a", name: "Config Model A", description: "Fast default" },
                { value: "cfg-model-b", name: "Config Model B", description: "Deep reasoning" },
              ],
            },
          ],
        },
      },
    });
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
    logEvent({ event: "session/prompt", sessionId: sid, promptText });
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
    error: { code: -32601, message: `Unsupported method: ${method}` },
  });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let idx = buf.indexOf("\n");
  while (idx !== -1) {
    const line = buf.slice(0, idx).replace(/\r$/, "");
    buf = buf.slice(idx + 1);
    if (line.trim().length > 0) {
      void handleRequest(JSON.parse(line) as Record<string, unknown>);
    }
    idx = buf.indexOf("\n");
  }
});
