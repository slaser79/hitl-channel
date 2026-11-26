#!/usr/bin/env bun
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  AcpSessionManager,
  HARNESS_REGISTRY,
  type AcpSessionManagerOptions,
  type McpTransportMode,
} from "./acp_session_manager.js";
import { pruneOldAuditFiles } from "./audit.js";
import { getChannelHome } from "./channel_home.js";
import { startHttpBridge } from "./http_bridge.js";
import { getHostname, getIdentity } from "./identity.js";
import { registerHitlTools } from "./mcp_tools.js";
import { startMDNS, stopMDNS } from "./mdns.js";
import { cleanupExpiredPairings } from "./pairing.js";

export interface DaemonCliArgs {
  harness: string;
  port: number;
  name?: string;
  cwd: string;
  mcpTransport: McpTransportMode;
  help: boolean;
}

function parseMcpTransportMode(raw: string): McpTransportMode {
  if (raw === "auto" || raw === "http" || raw === "stdio") {
    return raw;
  }
  throw new Error(
    `Invalid --mcp-transport '${raw}'. Expected: auto, http, stdio`,
  );
}

function parsePortNumber(raw: string, label: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return parsed;
}

export function parseDaemonArgs(argv: string[]): DaemonCliArgs {
  let harness = "agy";
  const rawEnvPort = process.env.HITL_CHANNEL_PORT;
  const envPort =
    rawEnvPort !== undefined && rawEnvPort.trim() !== ""
      ? parsePortNumber(rawEnvPort, "HITL_CHANNEL_PORT")
      : undefined;
  let explicitPort: number | undefined;
  let name: string | undefined;
  let cwd = process.cwd();
  const rawEnvTransport = process.env.HITL_MCP_TRANSPORT?.trim();
  let mcpTransport: McpTransportMode = rawEnvTransport
    ? parseMcpTransportMode(rawEnvTransport)
    : "auto";
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--harness" || arg.startsWith("--harness=")) {
      const val = arg.includes("=") ? arg.slice("--harness=".length) : argv[++i];
      if (!val) throw new Error("--harness requires a value");
      harness = val;
      continue;
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const raw = arg.includes("=") ? arg.slice("--port=".length) : argv[++i];
      if (raw === undefined || raw === "") {
        throw new Error("--port requires a value");
      }
      explicitPort = parsePortNumber(raw, "port");
      continue;
    }
    if (arg === "--name" || arg.startsWith("--name=")) {
      const val = arg.includes("=") ? arg.slice("--name=".length) : argv[++i];
      if (!val) throw new Error("--name requires a value");
      name = val;
      continue;
    }
    if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const val = arg.includes("=") ? arg.slice("--cwd=".length) : argv[++i];
      if (!val) throw new Error("--cwd requires a value");
      cwd = val;
      continue;
    }
    if (arg === "--mcp-transport" || arg.startsWith("--mcp-transport=")) {
      const val = arg.includes("=")
        ? arg.slice("--mcp-transport=".length)
        : argv[++i];
      if (!val) throw new Error("--mcp-transport requires a value");
      mcpTransport = parseMcpTransportMode(val);
      continue;
    }
    throw new Error(`Unknown daemon flag: ${arg}`);
  }

  if (!help && !HARNESS_REGISTRY[harness]) {
    throw new Error(
      `Unsupported harness '${harness}'. Supported: ${Object.keys(HARNESS_REGISTRY).join(", ")}`,
    );
  }

  const defaultPort = HARNESS_REGISTRY[harness]?.defaultPort ?? 8790;
  const port = explicitPort ?? envPort ?? defaultPort;

  return { harness, port, name, cwd, mcpTransport, help };
}

function constantTimeBearerMatch(
  authHeader: string | null,
  expectedToken: string,
): boolean {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const candidate = authHeader.slice(7);
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expectedToken, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface LoopbackMcpServerOptions {
  token?: string;
  getFallbackAcpSessionId?: () => string | null;
  getFallbackTurnId?: () => string | null;
  onChoicesPresented?: (choiceId: string) => void;
  onReplySent?: (acpSessionId?: string | null) => void;
}

export interface LoopbackMcpServerHandle {
  port: number;
  url: string;
  token: string;
  stop: () => void;
}

export function startLoopbackMcpServer(
  opts: LoopbackMcpServerOptions = {},
): LoopbackMcpServerHandle {
  const token = opts.token ?? randomBytes(32).toString("hex");

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);

      // OAuth protected-resource probe from agy must receive 404 without auth.
      if (url.pathname === "/.well-known" || url.pathname.startsWith("/.well-known/")) {
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.pathname !== "/mcp") {
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      if (!constantTimeBearerMatch(req.headers.get("authorization"), token)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      if (req.method === "GET") {
        return new Response(JSON.stringify({ error: "method_not_allowed" }), {
          status: 405,
          headers: {
            Allow: "POST, DELETE",
            "content-type": "application/json",
          },
        });
      }

      if (req.method === "DELETE") {
        return new Response(null, { status: 200 });
      }

      if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "method_not_allowed" }), {
          status: 405,
          headers: {
            Allow: "POST, DELETE",
            "content-type": "application/json",
          },
        });
      }

      const accept = req.headers.get("accept") ?? "";
      const normalizedReq =
        accept.includes("application/json") && accept.includes("text/event-stream")
          ? req
          : new Request(req, {
              headers: (() => {
                const headers = new Headers(req.headers);
                headers.set("accept", "application/json, text/event-stream");
                return headers;
              })(),
            });

      const requestAcpSessionId =
        req.headers.get("x-hitl-acp-session-id")?.trim() || null;
      const mcpServer = new Server(
        { name: "hitl-channel", version: "0.1.0" },
        { capabilities: { tools: {} } },
      );
      registerHitlTools(mcpServer, {
        mode: "daemon",
        requestAcpSessionId,
        getFallbackAcpSessionId: opts.getFallbackAcpSessionId,
        getFallbackTurnId: opts.getFallbackTurnId,
        onChoicesPresented: opts.onChoicesPresented,
        onReplySent: opts.onReplySent,
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcpServer.connect(transport);
      try {
        return await transport.handleRequest(normalizedReq);
      } finally {
        await mcpServer.close().catch(() => {});
        await transport.close().catch(() => {});
      }
    },
  });

  const port = server.port ?? 0;
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    stop: () => server.stop(true),
  };
}

function notifyDesktopPairingCode(code: string): void {
  try {
    if (process.platform === "darwin") {
      const child = spawn(
        "osascript",
        [
          "-e",
          `display notification "Pairing code: ${code}" with title "HITL Channel"`,
        ],
        { stdio: "ignore", detached: true },
      );
      child.on("error", () => {});
      child.unref();
    } else if (process.platform === "linux") {
      const child = spawn("notify-send", ["HITL Channel", `Pairing code: ${code}`], {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => {});
      child.unref();
    }
  } catch {
    // Best effort only
  }
}

export interface StartDaemonOptions {
  harness?: string;
  port?: number;
  name?: string;
  cwd?: string;
  mcpTransport?: McpTransportMode;
  identityFile?: string;
  enableMdns?: boolean;
  enableDesktopNotifications?: boolean;
  startHarnessImmediately?: boolean;
  transportFactory?: AcpSessionManagerOptions["transportFactory"];
  onPairingCode?: (code: string) => void | Promise<void>;
  outOfTurnQuietMs?: number;
  sessionLoadTimeoutMs?: number;
  streamCoalesceMs?: number;
}

export interface DaemonHandle {
  port: number;
  mcpUrl: string;
  mcpToken: string;
  instanceId: string;
  displayName: string;
  manager: AcpSessionManager;
  shutdown: () => Promise<void>;
}

export async function startDaemon(
  options: StartDaemonOptions = {},
): Promise<DaemonHandle> {
  const harness = options.harness ?? "agy";
  const harnessDef = HARNESS_REGISTRY[harness];
  if (!harnessDef) {
    throw new Error(`Unsupported harness '${harness}'`);
  }

  const rawEnvPort = process.env.HITL_CHANNEL_PORT?.trim();
  const requestedPort =
    options.port !== undefined
      ? options.port
      : rawEnvPort
        ? parsePortNumber(rawEnvPort, "HITL_CHANNEL_PORT")
        : harnessDef.defaultPort;
  const rawEnvTransport = process.env.HITL_MCP_TRANSPORT?.trim();
  const mcpTransport: McpTransportMode =
    options.mcpTransport ??
    (rawEnvTransport ? parseMcpTransportMode(rawEnvTransport) : "auto");

  const identityFile =
    options.identityFile ??
    process.env.HITL_CHANNEL_IDENTITY_FILE ??
    join(getChannelHome(), `identity-daemon-${harness}.json`);
  process.env.HITL_CHANNEL_IDENTITY_FILE = identityFile;

  const host = await getHostname();
  const displayName =
    options.name ??
    (process.env.HITL_CHANNEL_NAME?.trim() || `${harness}@${host}`);
  process.env.HITL_CHANNEL_NAME = displayName;

  const identity = await getIdentity();
  process.env.HITL_INSTANCE_ID = identity.instanceId;

  void pruneOldAuditFiles();

  let manager!: AcpSessionManager;

  const mcpHandle = startLoopbackMcpServer({
    getFallbackAcpSessionId: () => manager.getAttributionSessionId(),
    getFallbackTurnId: () => manager.getActiveTurnId(),
    onChoicesPresented: (choiceId) => manager.onChoicesPresented(choiceId),
    onReplySent: (sid) => manager.onReplySent(sid),
  });

  manager = new AcpSessionManager({
    harness,
    defaultCwd: options.cwd ?? process.cwd(),
    mcpUrl: mcpHandle.url,
    mcpToken: mcpHandle.token,
    mcpTransport,
    instanceId: identity.instanceId,
    transportFactory: options.transportFactory,
    outOfTurnQuietMs: options.outOfTurnQuietMs,
    sessionLoadTimeoutMs: options.sessionLoadTimeoutMs,
    streamCoalesceMs: options.streamCoalesceMs,
    onPairingCode: async (code) => {
      process.stdout.write(`PAIRING CODE: ${code}\n`);
      if (options.enableDesktopNotifications !== false) {
        notifyDesktopPairingCode(code);
      }
      await options.onPairingCode?.(code);
    },
  });

  const httpServer = startHttpBridge(manager.getInboundHandlers(), {
    port: requestedPort,
    mode: "daemon",
    harness,
    capabilities: {
      sessions: true,
      streaming: true,
      choicesId: true,
      models: true,
      commands: true,
    },
  });
  const actualPort = httpServer.port ?? requestedPort;

  const useMdns = options.enableMdns !== false;
  if (useMdns) {
    startMDNS(actualPort, identity.instanceId, identity.displayName, {
      mode: "daemon",
      harness,
    });
  }

  const pairingCleanupInterval = setInterval(() => {
    cleanupExpiredPairings();
  }, 60_000);

  if (options.startHarnessImmediately) {
    await manager.start();
  }

  process.stderr.write(
    `[hitl-channel] Daemon (${harness}) listening on http://0.0.0.0:${actualPort}\n`,
  );
  process.stderr.write(`[hitl-channel] Instance ID: ${identity.instanceId}\n`);
  process.stderr.write(`[hitl-channel] Display Name: ${identity.displayName}\n`);
  process.stderr.write(`[hitl-channel] Loopback MCP: ${mcpHandle.url}\n`);

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(pairingCleanupInterval);
    await manager.shutdown();
    try {
      httpServer.stop(true);
    } catch {
      // ignore
    }
    try {
      mcpHandle.stop();
    } catch {
      // ignore
    }
    if (useMdns) {
      try {
        stopMDNS();
      } catch {
        // ignore
      }
    }
  };

  return {
    port: actualPort,
    mcpUrl: mcpHandle.url,
    mcpToken: mcpHandle.token,
    instanceId: identity.instanceId,
    displayName: identity.displayName,
    manager,
    shutdown,
  };
}

export async function runDaemonCli(argv: string[]): Promise<void> {
  const parsed = parseDaemonArgs(argv);
  if (parsed.help) {
    process.stdout.write(
      [
        "Usage: hitl-channel daemon [options]",
        "",
        "Options:",
        "  --harness <name>          ACP harness to run: agy, codex, hermes (default: agy)",
        "  --port <port>             HTTP/WS bridge port (defaults: agy=8790, codex=8791, hermes=8792)",
        "  --name <name>             Display name (default: <harness>@<hostname>)",
        "  --cwd <dir>               Default working directory (default: cwd)",
        "  --mcp-transport <mode>    MCP transport: auto, http, stdio (default: auto)",
        "  -h, --help                Show this help message",
        "",
      ].join("\n"),
    );
    return;
  }

  let daemon: DaemonHandle | undefined;
  let exiting = false;
  let exitRequestedDuringBoot = false;
  const onSignal = (sig: string) => {
    if (exiting) return;
    exiting = true;
    process.stderr.write(`[hitl-channel] Daemon shutting down on ${sig}\n`);
    if (!daemon) {
      exitRequestedDuringBoot = true;
      return;
    }
    void daemon.shutdown().finally(() => process.exit(0));
  };

  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  daemon = await startDaemon({
    harness: parsed.harness,
    port: parsed.port,
    name: parsed.name,
    cwd: parsed.cwd,
    mcpTransport: parsed.mcpTransport,
  });

  if (exitRequestedDuringBoot) {
    await daemon.shutdown();
    process.exit(0);
  }
}

if (import.meta.main) {
  runDaemonCli(process.argv.slice(2)).catch((err) => {
    process.stderr.write(
      `[hitl-channel] Daemon fatal error: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(1);
  });
}
