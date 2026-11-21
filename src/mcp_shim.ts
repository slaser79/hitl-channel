#!/usr/bin/env bun
/**
 * Stdio ndjson <-> loopback HTTP MCP proxy (`hitl-channel mcp-shim`).
 *
 * Used by daemon mode when an ACP harness does not support HTTP MCP servers
 * natively (or `--mcp-transport stdio` is selected). Reads JSON-RPC lines from
 * stdin, forwards each message over loopback HTTP POST with Bearer auth, and
 * writes single-line JSON-RPC responses back to stdout.
 */

export interface McpShimArgs {
  url: string;
  token: string;
  acpSessionId?: string;
  help: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function assertLoopbackHttpUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid --url for mcp-shim: '${rawUrl}'`);
  }
  if (parsed.protocol !== "http:") {
    throw new Error(
      `mcp-shim only supports http:// loopback URLs (got '${parsed.protocol}')`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `mcp-shim refuses non-loopback host '${parsed.hostname}' (allowed: 127.0.0.1, localhost, ::1)`,
    );
  }
  return parsed.toString();
}

export function parseMcpShimArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): McpShimArgs {
  let url = "";
  let token = env.HITL_MCP_SHIM_TOKEN?.trim() || "";
  let acpSessionId = env.HITL_MCP_SHIM_SESSION_ID?.trim() || undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--url" || arg.startsWith("--url=")) {
      const val = arg.includes("=") ? arg.slice("--url=".length) : argv[++i];
      if (!val) throw new Error("--url requires a value");
      url = val;
      continue;
    }
    if (arg === "--token" || arg.startsWith("--token=")) {
      const val = arg.includes("=") ? arg.slice("--token=".length) : argv[++i];
      if (!val) throw new Error("--token requires a value");
      token = val;
      continue;
    }
    if (arg === "--acp-session-id" || arg.startsWith("--acp-session-id=")) {
      const val = arg.includes("=")
        ? arg.slice("--acp-session-id=".length)
        : argv[++i];
      if (!val) throw new Error("--acp-session-id requires a value");
      acpSessionId = val;
      continue;
    }
    throw new Error(`Unknown mcp-shim flag: ${arg}`);
  }

  if (!help) {
    if (!url) {
      throw new Error("mcp-shim requires --url <loopback-http-url>");
    }
    if (!token) {
      throw new Error(
        "mcp-shim requires --token <bearer-token> or HITL_MCP_SHIM_TOKEN",
      );
    }
    url = assertLoopbackHttpUrl(url);
  }

  return { url, token, acpSessionId, help };
}

export function parseSsePayloads(sseText: string): string[] {
  const events = sseText.split(/\r?\n\r?\n/);
  const payloads: string[] = [];

  for (const event of events) {
    const dataLines: string[] = [];
    for (const rawLine of event.split(/\r?\n/)) {
      if (rawLine.startsWith("data:")) {
        let value = rawLine.slice("data:".length);
        if (value.startsWith(" ")) {
          value = value.slice(1);
        }
        dataLines.push(value);
      }
    }
    if (dataLines.length === 0) continue;
    const joined = dataLines.join("\n").trim();
    if (!joined || joined === "[DONE]") continue;
    payloads.push(joined);
  }

  return payloads;
}

export interface McpShimProcessorOptions {
  url: string;
  token: string;
  acpSessionId?: string;
  fetchImpl?: typeof fetch;
  writeLine: (line: string) => void;
  writeError?: (msg: string) => void;
}

export function createMcpShimProcessor(opts: McpShimProcessorOptions) {
  const url = assertLoopbackHttpUrl(opts.url);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const writeError =
    opts.writeError ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  const emitRpcError = (id: unknown, message: string) => {
    if (id === undefined) return;
    opts.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message },
      }),
    );
  };

  return async function processLine(rawLine: string): Promise<void> {
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (err) {
      writeError(
        `[hitl-channel mcp-shim] Ignoring invalid JSON line: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return;
    }

    const reqId = Object.prototype.hasOwnProperty.call(parsed, "id")
      ? parsed.id
      : undefined;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${opts.token}`,
    };
    if (opts.acpSessionId) {
      headers["x-hitl-acp-session-id"] = opts.acpSessionId;
    }

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(parsed),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeError(`[hitl-channel mcp-shim] Loopback HTTP error: ${msg}`);
      emitRpcError(reqId, `Loopback HTTP request failed: ${msg}`);
      return;
    }

    if (res.status === 202 || res.status === 204) {
      await res.body?.cancel().catch(() => {});
      return;
    }

    const bodyText = await res.text();
    if (!res.ok) {
      if (reqId !== undefined && bodyText.trim().length > 0) {
        try {
          const errJson = JSON.parse(bodyText) as Record<string, unknown>;
          if (errJson && errJson.jsonrpc === "2.0" && "error" in errJson) {
            opts.writeLine(JSON.stringify(errJson));
            return;
          }
        } catch {
          // Fall through to generic JSON-RPC error frame.
        }
      }
      const detail = bodyText.trim() || `HTTP ${res.status}`;
      writeError(
        `[hitl-channel mcp-shim] HTTP ${res.status} from ${url}: ${detail}`,
      );
      emitRpcError(reqId, `HTTP ${res.status}: ${detail}`);
      return;
    }

    if (bodyText.trim().length === 0) {
      return;
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
      const payloads = parseSsePayloads(bodyText);
      for (const payload of payloads) {
        try {
          const obj = JSON.parse(payload);
          opts.writeLine(JSON.stringify(obj));
        } catch (err) {
          writeError(
            `[hitl-channel mcp-shim] Invalid SSE JSON payload: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      }
      return;
    }

    try {
      const obj = JSON.parse(bodyText);
      opts.writeLine(JSON.stringify(obj));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeError(`[hitl-channel mcp-shim] Invalid JSON response: ${msg}`);
      emitRpcError(reqId, `Invalid JSON response: ${msg}`);
    }
  };
}

export async function runMcpShimCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const parsed = parseMcpShimArgs(argv, env);
  if (parsed.help) {
    process.stdout.write(
      [
        "Usage: hitl-channel mcp-shim --url <loopback-http-url> [options]",
        "",
        "Options:",
        "  --url <url>              Loopback HTTP MCP endpoint (127.0.0.1 / localhost / ::1)",
        "  --token <token>          Bearer token (or HITL_MCP_SHIM_TOKEN env)",
        "  --acp-session-id <id>    Session attribution header (or HITL_MCP_SHIM_SESSION_ID env)",
        "  -h, --help               Show this help message",
        "",
      ].join("\n"),
    );
    return;
  }

  const processLine = createMcpShimProcessor({
    url: parsed.url,
    token: parsed.token,
    acpSessionId: parsed.acpSessionId,
    writeLine: (line) => {
      process.stdout.write(`${line}\n`);
    },
  });

  const inFlight = new Set<Promise<void>>();
  const enqueue = (line: string) => {
    const p = processLine(line).finally(() => {
      inFlight.delete(p);
    });
    inFlight.add(p);
  };

  let buffer = "";
  let ended = false;
  let onEndResolve!: () => void;
  const endPromise = new Promise<void>((resolve) => {
    onEndResolve = resolve;
  });

  const finish = () => {
    if (ended) return;
    ended = true;
    if (buffer.trim().length > 0) {
      enqueue(buffer);
      buffer = "";
    }
    onEndResolve();
  };

  const onData = (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nlIdx = buffer.indexOf("\n");
    while (nlIdx !== -1) {
      const line = buffer.slice(0, nlIdx);
      buffer = buffer.slice(nlIdx + 1);
      enqueue(line);
      nlIdx = buffer.indexOf("\n");
    }
  };

  const onSignal = () => {
    finish();
    process.exit(0);
  };

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onData);
  process.stdin.on("end", finish);
  process.stdin.on("close", finish);
  process.stdin.resume();

  try {
    await endPromise;
    await Promise.allSettled(Array.from(inFlight));
  } finally {
    process.stdin.off("data", onData);
    process.stdin.off("end", finish);
    process.stdin.off("close", finish);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

if (import.meta.main) {
  runMcpShimCli(process.argv.slice(2)).catch((err) => {
    process.stderr.write(
      `[hitl-channel] mcp-shim fatal error: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(1);
  });
}
