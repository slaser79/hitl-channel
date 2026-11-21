#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttpBridge } from "./http_bridge.js";
import { getIdentity } from "./identity.js";
import { startMDNS, stopMDNS } from "./mdns.js";
import { cleanupExpiredPairings } from "./pairing.js";
import { pruneOldAuditFiles } from "./audit.js";
import { registerHitlTools } from "./mcp_tools.js";

// Re-export path-allowlist & attachment helpers for pre-existing tests (AV13).
export {
  resolveAttachments,
  attachmentRoots,
  isPathAllowed,
  kMaxFileReadBytes,
} from "./mcp_tools.js";

const PORT = Number(process.env.HITL_CHANNEL_PORT ?? 8789);

// SPEC-HITL-CC-001 §4.2 + Phase 3 standing-orders contract is composed in
// `mcp_instructions.ts` so the AC#23a snapshot test can import it without
// triggering this module's top-level `await mcp.connect(...)`.
import { MCP_INSTRUCTIONS } from "./mcp_instructions.js";

export const mcp = new Server(
  { name: "hitl-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: MCP_INSTRUCTIONS,
  }
);

registerHitlTools(mcp, { mode: "channel" });

// Graceful shutdown: Claude Code spawns us as a stdio subprocess. When the
// parent claude exits, stdin closes — that's our cue to release the HTTP
// listener on $HITL_CHANNEL_PORT (default 8789) so the next session's spawn
// can bind. Without this, `Bun.serve()` + the pairing-cleanup interval keep
// the event loop alive indefinitely; the process is reparented to PID 1 and
// blocks every future spawn with EADDRINUSE.
//
// Handlers MUST be registered BEFORE any await — if the parent exits during
// `getIdentity()` / `mcp.connect()` / `startHttpBridge()`, the close event
// is otherwise missed and the late-registered handlers never fire.
// `httpServer` / `pairingCleanupInterval` are declared `let` (not `const`)
// because shutdown can fire during the init window, before they're assigned;
// null-checks inside shutdown() avoid the TDZ ReferenceError that a hoisted
// function declaration over `const` declarations would otherwise hit.
let httpServer: ReturnType<typeof startHttpBridge> | undefined;
let pairingCleanupInterval: ReturnType<typeof setInterval> | undefined;
let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`[hitl-channel] Shutting down on ${reason}\n`);
  if (httpServer !== undefined) {
    try {
      httpServer.stop(true);
    } catch (e) {
      process.stderr.write(
        `[hitl-channel] httpServer.stop error: ${String(e)}\n`
      );
    }
  }
  try {
    stopMDNS();
  } catch (e) {
    process.stderr.write(`[hitl-channel] stopMDNS error: ${String(e)}\n`);
  }
  if (pairingCleanupInterval !== undefined) {
    clearInterval(pairingCleanupInterval);
  }
  process.exit(0);
}

if (process.env.BUN_ENV !== "test" && process.env.NODE_ENV !== "test") {
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  process.stdin.on("end", () => shutdown("stdin-EOF"));
  process.stdin.on("close", () => shutdown("stdin-close"));

  // Initialize instance identity and start services
  const identity = await getIdentity();
  // Propagate to env so http_bridge audit-on-message can stamp instance_id
  // without re-reading the identity file on every WS frame.
  process.env.HITL_INSTANCE_ID = identity.instanceId;
  process.stderr.write(
    `[hitl-channel] HITL Channel server listening on http://0.0.0.0:${PORT}\n`
  );
  process.stderr.write(`[hitl-channel] Instance ID: ${identity.instanceId}\n`);
  process.stderr.write(`[hitl-channel] Display Name: ${identity.displayName}\n`);

  // SPEC-HITL-CC-001 §4.2 — best-effort audit retention prune at startup.
  void pruneOldAuditFiles();

  // Start mDNS advertising
  startMDNS(PORT, identity.instanceId, identity.displayName);

  // Start periodic cleanup of expired pairing codes (every minute)
  pairingCleanupInterval = setInterval(() => {
    cleanupExpiredPairings();
  }, 60000);

  await mcp.connect(new StdioServerTransport());

  httpServer = startHttpBridge(mcp);

  // Belt-and-braces: if stdin already reached end while we were awaiting the
  // transport / HTTP bridge, the `end` event has already fired and our late
  // listener will never see it. Check the readable state explicitly.
  if ((process.stdin as { readableEnded?: boolean }).readableEnded) {
    shutdown("stdin-already-ended");
  }
}
