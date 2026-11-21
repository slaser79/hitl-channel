import { spawn } from "node:child_process";

export interface AcpMcpHttpHeader {
  name: string;
  value: string;
}

export type AcpMcpServer =
  | {
      type: "http";
      name: string;
      url: string;
      headers: AcpMcpHttpHeader[];
    }
  | {
      name: string;
      command: string;
      args: string[];
      env?: Array<{ name: string; value: string }>;
    };

export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface AcpSystemPrompt {
  mode: "append";
  content: Array<{ type: "text"; text: string }>;
}

export interface AcpSessionInfo {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface AcpPermissionToolCall {
  toolCallId?: string;
  name?: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  status?: string;
  [key: string]: unknown;
}

export interface AcpPermissionRequestParams {
  sessionId: string;
  toolCall: AcpPermissionToolCall;
  options: AcpPermissionOption[];
  [key: string]: unknown;
}

export interface AcpPermissionResponse {
  outcome:
    | { outcome: "selected"; optionId: string }
    | { outcome: "cancelled" };
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  sessionCapabilities?: {
    resume?: Record<string, unknown>;
    close?: Record<string, unknown>;
    load?: Record<string, unknown>;
    list?: Record<string, unknown>;
    systemPrompt?: Record<string, unknown>;
    [key: string]: unknown;
  };
  mcpCapabilities?: {
    http?: boolean;
    sse?: boolean;
    acp?: boolean;
    [key: string]: unknown;
  };
  promptCapabilities?: {
    image?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: AcpAgentCapabilities;
  agentInfo?: {
    name?: string;
    version?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AcpPromptResult {
  stopReason: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: {
    sessionUpdate: string;
    content?: { type?: string; text?: string };
    title?: string;
    toolCallId?: string;
    name?: string;
    kind?: string;
    rawInput?: unknown;
    status?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AcpTransport {
  readonly pid?: number;
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  close(): Promise<void>;
}

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(`ACP RPC error ${code}: ${message}`);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
  }
}

export function spawnAcpTransport(
  command: string,
  args: string[],
  opts?: {
    env?: Record<string, string | undefined>;
    cwd?: string;
  },
): AcpTransport {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...opts?.env,
    HITL_DAEMON_SESSION: "1",
  };

  const child = spawn(command, args, {
    cwd: opts?.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: childEnv as NodeJS.ProcessEnv,
  });

  const lineCallbacks: Array<(line: string) => void> = [];
  const closeCallbacks: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  let stdoutBuf = "";
  let exited = false;
  let exitResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let closeNotified = false;
  const exitWaiters: Array<() => void> = [];

  const notifyClose = (code: number | null, signal: NodeJS.Signals | null) => {
    exited = true;
    exitResult = { code, signal };
    while (exitWaiters.length > 0) {
      exitWaiters.shift()?.();
    }
    if (closeNotified) return;
    closeNotified = true;
    for (const cb of closeCallbacks) {
      try {
        cb(code, signal);
      } catch (err) {
        process.stderr.write(
          `[hitl-channel] ACP transport close callback error: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      }
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let idx = stdoutBuf.indexOf("\n");
    while (idx !== -1) {
      const rawLine = stdoutBuf.slice(0, idx).replace(/\r$/, "");
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (rawLine.length > 0) {
        for (const cb of lineCallbacks) {
          cb(rawLine);
        }
      }
      idx = stdoutBuf.indexOf("\n");
    }
  });
  child.stdout?.on("end", () => {
    const tail = stdoutBuf.replace(/\r$/, "");
    stdoutBuf = "";
    if (tail.length > 0) {
      for (const cb of lineCallbacks) {
        cb(tail);
      }
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    process.stderr.write(`[hitl-channel][acp-stderr] ${chunk}`);
  });

  child.once("exit", (code, signal) => {
    notifyClose(code, signal);
  });

  child.once("error", (err) => {
    process.stderr.write(
      `[hitl-channel] ACP child error (${command}): ${err.message}\n`,
    );
    notifyClose(1, null);
  });

  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ESRCH") {
        try {
          child.kill(signal);
        } catch {
          // ignore
        }
      }
    }
  };

  return {
    get pid() {
      return child.pid;
    },
    send(line: string) {
      if (exited || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
        return;
      }
      child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
    },
    onLine(cb) {
      lineCallbacks.push(cb);
    },
    onClose(cb) {
      closeCallbacks.push(cb);
      if (closeNotified && exitResult) {
        const res = exitResult;
        queueMicrotask(() => cb(res.code, res.signal));
      }
    },
    async close() {
      if (exited) return;
      try {
        child.stdin?.end();
      } catch {
        // ignore
      }
      killGroup("SIGTERM");

      const waitExit = (ms: number) =>
        new Promise<boolean>((resolve) => {
          if (exited) {
            resolve(true);
            return;
          }
          const timer = setTimeout(() => resolve(exited), ms);
          exitWaiters.push(() => {
            clearTimeout(timer);
            resolve(true);
          });
        });

      const done = await waitExit(2000);
      if (!done && !exited) {
        killGroup("SIGKILL");
        await waitExit(1000);
      }
    },
  };
}

interface PendingRpc {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class AcpClient {
  private readonly transport: AcpTransport;
  private nextId = 0;
  private readonly pending = new Map<string | number, PendingRpc>();
  private closing = false;
  private closed = false;

  private updateHandler?: (params: AcpSessionUpdateParams) => void;
  private permissionHandler?: (
    id: string | number,
    params: AcpPermissionRequestParams,
  ) => void;
  private exitHandler?: (code: number | null, signal: NodeJS.Signals | null) => void;

  constructor(transport: AcpTransport) {
    this.transport = transport;
    this.transport.onLine((line) => this.handleLine(line));
    this.transport.onClose((code, signal) => this.handleTransportClose(code, signal));
  }

  get pid(): number | undefined {
    return this.transport.pid;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onSessionUpdate(cb: (params: AcpSessionUpdateParams) => void): void {
    this.updateHandler = cb;
  }

  onPermissionRequest(
    cb: (id: string | number, params: AcpPermissionRequestParams) => void,
  ): void {
    this.permissionHandler = cb;
  }

  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitHandler = cb;
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      process.stderr.write(
        `[hitl-channel] ACP non-JSON line: ${line.slice(0, 200)}\n`,
      );
      return;
    }

    const id = msg.id as string | number | undefined;
    const hasResultOrError = "result" in msg || "error" in msg;

    if (id !== undefined && hasResultOrError && typeof msg.method !== "string") {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);

      if ("error" in msg && msg.error != null && typeof msg.error === "object") {
        const errObj = msg.error as {
          code?: number;
          message?: string;
          data?: unknown;
        };
        pending.reject(
          new AcpRpcError(
            errObj.code ?? -32000,
            errObj.message ?? "Unknown ACP error",
            errObj.data,
          ),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    const method = typeof msg.method === "string" ? msg.method : undefined;
    if (!method) return;

    if (method === "session/update") {
      if (msg.params && typeof msg.params === "object") {
        this.updateHandler?.(msg.params as AcpSessionUpdateParams);
      }
      return;
    }

    if (method === "session/request_permission" && id !== undefined) {
      if (this.permissionHandler && msg.params && typeof msg.params === "object") {
        this.permissionHandler(id, msg.params as AcpPermissionRequestParams);
      } else {
        this.respond(id, { outcome: { outcome: "cancelled" } });
      }
      return;
    }

    // Fail-closed JSON-RPC response for unhandled server-to-client requests
    if (id !== undefined) {
      this.respondError(id, -32601, `Method not supported: ${method}`);
    }
  }

  private handleTransportClose(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.closed = true;
    const err = new Error(
      `ACP transport closed (code=${code ?? "null"}, signal=${signal ?? "null"})`,
    );
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    if (!this.closing) {
      this.exitHandler?.(code, signal);
    }
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 120_000,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`ACP client is closed (${method})`));
    }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP request timeout (${method}, ${timeoutMs}ms)`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.transport.send(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        );
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.closed) return;
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  respond(id: string | number, result: unknown): void {
    if (this.closed) return;
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  respondError(
    id: string | number,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    if (this.closed) return;
    this.transport.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code, message, ...(data !== undefined ? { data } : {}) },
      }),
    );
  }

  async initialize(): Promise<AcpInitializeResult> {
    return this.request<AcpInitializeResult>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "hitl-channel-daemon", version: "0.1.0" },
    });
  }

  private buildSessionLifecyclePayload<
    T extends {
      cwd: string;
      mcpServers: AcpMcpServer[];
      systemPrompt?: AcpSystemPrompt;
      _meta?: Record<string, unknown>;
      sessionId?: string;
    },
  >(params: T): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      cwd: params.cwd,
      mcpServers: params.mcpServers,
    };
    if (params.systemPrompt !== undefined) {
      payload.systemPrompt = params.systemPrompt;
    }
    if (params._meta !== undefined) {
      payload._meta = params._meta;
    }
    return payload;
  }

  async sessionNew(params: {
    cwd: string;
    mcpServers: AcpMcpServer[];
    systemPrompt?: AcpSystemPrompt;
    _meta?: Record<string, unknown>;
  }): Promise<{ sessionId: string; [key: string]: unknown }> {
    return this.request("session/new", this.buildSessionLifecyclePayload(params));
  }

  async sessionList(
    params: { cwd?: string; cursor?: string } = {},
  ): Promise<{ sessions: AcpSessionInfo[]; nextCursor?: string }> {
    const all: AcpSessionInfo[] = [];
    let cursor = params.cursor;
    for (let page = 0; page < 10; page++) {
      const reqParams: Record<string, unknown> = {};
      if (params.cwd) reqParams.cwd = params.cwd;
      if (cursor) reqParams.cursor = cursor;
      const res = await this.request<{
        sessions?: AcpSessionInfo[];
        nextCursor?: string;
      }>("session/list", reqParams);
      if (Array.isArray(res?.sessions)) {
        all.push(...res.sessions);
      }
      if (!res?.nextCursor || typeof res.nextCursor !== "string") {
        return { sessions: all };
      }
      cursor = res.nextCursor;
    }
    return { sessions: all };
  }

  async sessionResume(params: {
    sessionId: string;
    cwd: string;
    mcpServers: AcpMcpServer[];
    systemPrompt?: AcpSystemPrompt;
    _meta?: Record<string, unknown>;
  }): Promise<{ [key: string]: unknown }> {
    return this.request("session/resume", this.buildSessionLifecyclePayload(params));
  }

  async sessionLoad(params: {
    sessionId: string;
    cwd: string;
    mcpServers: AcpMcpServer[];
    systemPrompt?: AcpSystemPrompt;
    _meta?: Record<string, unknown>;
  }): Promise<{ [key: string]: unknown }> {
    return this.request("session/load", this.buildSessionLifecyclePayload(params));
  }

  async sessionPrompt(params: {
    sessionId: string;
    prompt: AcpContentBlock[];
  }): Promise<AcpPromptResult> {
    // Prompt turns can wait on long-running phone tool calls (up to 300s)
    // or user permission taps; do not apply a short RPC timeout.
    return this.request("session/prompt", params, 0);
  }

  sessionCancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.transport.close();
  }
}
