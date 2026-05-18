#!/usr/bin/env bun
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve as resolvePath } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  startHttpBridge,
  broadcastReply,
  broadcastFrame,
  correlator,
  clients,
} from "./http_bridge.js";
import { getIdentity } from "./identity.js";
import { startMDNS, stopMDNS } from "./mdns.js";
import { cleanupExpiredPairings } from "./pairing.js";
import {
  appendAudit,
  pruneOldAuditFiles,
  sha256Hex,
  summariseAttachments,
} from "./audit.js";
import type {
  HitlAttachment,
  ListToolsResultFrame,
  ToolCallResultFrame,
} from "./types.js";

const PORT = Number(process.env.HITL_CHANNEL_PORT ?? 8789);

// SPEC-HITL-CC-001 §4.2 + Phase 3 standing-orders contract is composed in
// `mcp_instructions.ts` so the AC#23a snapshot test can import it without
// triggering this module's top-level `await mcp.connect(...)`.
import { MCP_INSTRUCTIONS } from "./mcp_instructions.js";

const mcp = new Server(
  { name: "hitl-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: MCP_INSTRUCTIONS,
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply_to_hitl",
      description:
        "Send a reply message back to the HITL mobile app user. " +
        "Pass the message_id from the inbound channel tag for threading. " +
        "Optionally include image/file attachments — they render inline " +
        "on the phone CC chat (images = thumbnail + tap-to-zoom; other " +
        "mime types = filename chip).",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The reply text to send back to the HITL app",
          },
          message_id: {
            type: "string",
            description: "Optional message ID for reply threading",
          },
          agent_id: {
            type: "string",
            description: "Optional agent identity for multi-instance routing",
          },
          attachments: {
            type: "array",
            description:
              "Optional attachments to render in the phone chat bubble. " +
              "Prefer `path` (absolute filesystem path on the channel host) — " +
              "the server reads the file and encodes it. Use `data` (base64) " +
              "only for in-memory bytes you've already encoded. " +
              "Per-attachment cap 5 MB; per-frame cap 20 MB (decoded). " +
              "Oversize attachments are dropped phone-side with a warning.",
            items: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description:
                    "Absolute filesystem path. Channel reads + base64-encodes. " +
                    "If omitted, `data` is required.",
                },
                type: {
                  type: "string",
                  description:
                    "'image' or 'file'. If omitted, inferred from media_type. " +
                    "Image attachments render inline; files render as a " +
                    "filename chip with mime icon.",
                },
                media_type: {
                  type: "string",
                  description:
                    "MIME type (e.g. 'image/png', 'application/pdf'). " +
                    "If omitted with `path`, inferred from file extension.",
                },
                data: {
                  type: "string",
                  description:
                    "Base64-encoded attachment bytes. Ignored if `path` is set.",
                },
                fileName: {
                  type: "string",
                  description:
                    "Optional filename for chip rendering. If omitted with " +
                    "`path`, derived from the path's basename.",
                },
              },
            },
          },
        },
        required: ["text"],
      },
    },
    {
      name: "present_choices_to_hitl",
      description:
        "Present choices to the HITL mobile app user for selection. " +
        "The user's selection will arrive as an inbound channel message.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The question or prompt to show the user",
          },
          choices: {
            type: "array",
            items: { type: "string" },
            description: "List of choice labels",
          },
          multi_select: {
            type: "boolean",
            description: "Allow multiple selections (default: false)",
          },
        },
        required: ["prompt", "choices"],
      },
    },
    // ─── SPEC-HITL-CC-001 Phase 1 ────────────────────────────────────────
    {
      name: "list_phone_tools",
      description:
        "List the on-device tools available on the paired HITL phone. " +
        "Returns the catalog of InternalToolsService tools (~60) with name, " +
        "description, inputSchema, and trust tier (free | softConfirm | hardConfirm). " +
        "Excludes UI-flow primitives tagged inAppOnly.",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            description: "Optional substring filter on tool name.",
          },
        },
      },
    },
    {
      name: "call_phone_tool",
      description:
        "Invoke an on-device tool on the paired HITL phone (e.g. list_events, " +
        "compose_email, navigate_to_agent, create_local_agent). " +
        "Soft/hard-confirm tools surface the existing trust-tier sheet on the " +
        "phone; the call returns with approval = 'auto' | 'user_approved' | " +
        "'user_denied' | 'timeout'. Free-tier tools run silently. " +
        "Use list_phone_tools() for the live catalog.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Tool name (from list_phone_tools).",
          },
          arguments: {
            type: "object",
            description: "Tool arguments matching the tool's inputSchema.",
          },
          timeout_seconds: {
            type: "number",
            description: "Round-trip timeout. Default 60, hard cap 300.",
          },
        },
        required: ["name"],
      },
    },
  ],
}));

function generateRequestId(): string {
  return globalThis.crypto.randomUUID();
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  json: "application/json",
  csv: "text/csv",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

// Per-attachment file-read cap. Matches the spec's 5 MB per-attachment
// limit (SPEC-HITL-CC-001 AC#35) and bounds memory pressure if a caller
// supplies an absurdly large file path. Bigger files are rejected at
// stat time, before any base64 encoding.
const kMaxFileReadBytes = 5 * 1024 * 1024;

// Allowlist of directory prefixes a `path` attachment may resolve under.
// Defaults to the user's home directory + tmpdir; an operator can widen
// or narrow via HITL_CHANNEL_ATTACHMENT_ROOTS (colon-separated absolute
// paths). The check uses `path.resolve` to normalise away `..` segments
// before the prefix match so a caller can't escape via `~/../etc/passwd`.
function attachmentRoots(): string[] {
  const env = process.env.HITL_CHANNEL_ATTACHMENT_ROOTS;
  if (env && env.trim().length > 0) {
    return env
      .split(":")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => resolvePath(p));
  }
  return [resolvePath(homedir()), resolvePath(tmpdir())];
}

function isPathAllowed(absolute: string, roots: string[]): boolean {
  for (const root of roots) {
    if (absolute === root) return true;
    // Append a separator to the root so /home/foo doesn't match /home/foobar.
    const prefix = root.endsWith("/") ? root : root + "/";
    if (absolute.startsWith(prefix)) return true;
  }
  return false;
}

async function resolveAttachments(raw: unknown): Promise<HitlAttachment[]> {
  if (!Array.isArray(raw)) return [];
  const roots = attachmentRoots();
  const out: HitlAttachment[] = [];
  for (const att of raw) {
    if (att == null || typeof att !== "object") continue;
    const a = att as {
      path?: unknown;
      type?: unknown;
      media_type?: unknown;
      data?: unknown;
      fileName?: unknown;
    };
    let data: string | undefined;
    let mediaType =
      typeof a.media_type === "string" ? a.media_type : undefined;
    let fileName =
      typeof a.fileName === "string" ? a.fileName : undefined;
    if (typeof a.path === "string" && a.path.length > 0) {
      const absolute = resolvePath(a.path);
      if (!isPathAllowed(absolute, roots)) {
        process.stderr.write(
          `[hitl-channel] reply_to_hitl: rejecting path outside allowlisted roots: ${absolute}\n`,
        );
        continue;
      }
      try {
        const st = await stat(absolute);
        if (!st.isFile()) {
          process.stderr.write(
            `[hitl-channel] reply_to_hitl: path is not a regular file: ${absolute}\n`,
          );
          continue;
        }
        if (st.size > kMaxFileReadBytes) {
          process.stderr.write(
            `[hitl-channel] reply_to_hitl: attachment_too_large size=${st.size} max=${kMaxFileReadBytes} path=${absolute}\n`,
          );
          continue;
        }
        const buf = await readFile(absolute);
        data = buf.toString("base64");
        if (!fileName) fileName = basename(absolute);
        if (!mediaType) {
          const ext = extname(absolute).slice(1).toLowerCase();
          mediaType = MIME_BY_EXT[ext] ?? "application/octet-stream";
        }
      } catch (err) {
        process.stderr.write(
          `[hitl-channel] reply_to_hitl: failed to read ${absolute}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
        continue;
      }
    } else if (typeof a.data === "string" && a.data.length > 0) {
      data = a.data;
      // When the caller supplies pre-encoded bytes via `data` and omits
      // `media_type`, default to a generic binary type rather than
      // silently dropping the entry. The phone-side codec uses this
      // for `type` inference; falling back to octet-stream keeps the
      // attachment round-tripping as a file-chip rather than disappearing.
      if (!mediaType) mediaType = "application/octet-stream";
    } else {
      continue;
    }
    if (!mediaType) continue;
    const type =
      typeof a.type === "string" && a.type.length > 0
        ? a.type
        : mediaType.startsWith("image/")
          ? "image"
          : "file";
    const entry: HitlAttachment = {
      type,
      media_type: mediaType,
      data,
    };
    if (fileName) entry.fileName = fileName;
    out.push(entry);
  }
  return out;
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const identity = await getIdentity();

  if (req.params.name === "reply_to_hitl") {
    const text = args.text as string;
    const messageId = args.message_id as string | undefined;
    const agentId = args.agent_id as string | undefined;
    const rawAttachments = args.attachments;
    const attachments: HitlAttachment[] = await resolveAttachments(
      rawAttachments,
    );
    const { count: attachmentCount, bytes: attachmentBytes } =
      summariseAttachments(attachments);

    process.stderr.write(
      `[hitl-channel] Reply: ${text} (msg: ${messageId}, agent: ${agentId}, attachments: ${attachmentCount})\n`
    );

    broadcastReply(text, messageId, agentId, attachments);
    void appendAudit({
      ts: new Date().toISOString(),
      instance_id: identity.instanceId,
      direction: "cc_to_phone",
      kind: "reply",
      tool_name: null,
      approval: null,
      prompt_hash: sha256Hex(text ?? ""),
      duration_ms: null,
      attachment_count: attachmentCount,
      attachment_bytes: attachmentBytes,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Sent to HITL app: ${text} (attachments: ${attachmentCount})`,
        },
      ],
    };
  }

  if (req.params.name === "present_choices_to_hitl") {
    const prompt = args.prompt as string;
    const choices = args.choices as string[];
    const multiSelect = args.multi_select as boolean | undefined;

    process.stderr.write(
      `[hitl-channel] Choices: ${prompt} [${choices.join(", ")}] (multi: ${multiSelect ?? false})\n`
    );

    const payload = JSON.stringify({
      type: "choices",
      content: prompt,
      choices: choices,
      multiSelect: multiSelect ?? false,
      id: `c${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
    });

    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
    void appendAudit({
      ts: new Date().toISOString(),
      instance_id: identity.instanceId,
      direction: "cc_to_phone",
      kind: "choices",
      tool_name: null,
      approval: null,
      prompt_hash: sha256Hex(prompt ?? ""),
      duration_ms: null,
      // No attachments on choices frames today (issue #12 closed-schema default).
      attachment_count: 0,
      attachment_bytes: 0,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Choices presented to user: ${choices.join(", ")}`,
        },
      ],
    };
  }

  // ─── SPEC-HITL-CC-001 Phase 1 ─────────────────────────────────────────
  if (req.params.name === "list_phone_tools") {
    if (clients.size === 0) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "No paired HITL phone is currently connected.",
          },
        ],
      };
    }
    const filter = (args.filter as string | undefined) ?? undefined;
    const requestId = generateRequestId();
    const frame = {
      type: "list_tools_request" as const,
      request_id: requestId,
      ...(filter ? { filter } : {}),
    };
    const waiter = correlator.register<ListToolsResultFrame>(requestId, 30_000);
    const delivered = broadcastFrame(frame);
    if (delivered === 0) {
      correlator.reject(requestId, new Error("no_phone_connected_post_check"));
    }
    try {
      const result = await waiter;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { tools: result.tools ?? [] },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `list_phone_tools failed: ${err instanceof Error ? err.message : err}`,
          },
        ],
      };
    }
  }

  if (req.params.name === "call_phone_tool") {
    if (clients.size === 0) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "No paired HITL phone is currently connected.",
          },
        ],
      };
    }
    const name = args.name as string | undefined;
    if (!name || typeof name !== "string") {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "call_phone_tool requires `name` (string).",
          },
        ],
      };
    }
    const toolArgs = (args.arguments as Record<string, unknown> | undefined) ?? {};
    const rawTimeout = Number(args.timeout_seconds ?? 60);
    const timeoutSeconds = Math.min(
      300,
      Math.max(1, Number.isFinite(rawTimeout) ? rawTimeout : 60),
    );
    const requestId = generateRequestId();
    const frame = {
      type: "tool_call_request" as const,
      request_id: requestId,
      name,
      arguments: toolArgs,
      timeout_seconds: timeoutSeconds,
      cc_instance_id: identity.instanceId,
    };
    const startedAt = Date.now();
    void appendAudit({
      ts: new Date(startedAt).toISOString(),
      instance_id: identity.instanceId,
      direction: "cc_calls_phone",
      kind: "tool_call",
      tool_name: name,
      approval: null,
      prompt_hash: sha256Hex(JSON.stringify(toolArgs)),
      duration_ms: null,
      // Issue #12 AC4 boundary — `cc_calls_phone` audit emission for
      // CC-supplied attachments-as-input is out-of-scope (no phone tool today
      // consumes a CC-supplied attachment). File a follow-up if that changes.
      attachment_count: 0,
      attachment_bytes: 0,
    });
    const waiter = correlator.register<ToolCallResultFrame>(
      requestId,
      timeoutSeconds * 1000,
    );
    const delivered = broadcastFrame(frame);
    if (delivered === 0) {
      correlator.reject(requestId, new Error("no_phone_connected_post_check"));
    }
    try {
      const result = await waiter;
      const duration = Date.now() - startedAt;
      // Issue #12 — `result` is the resolved `tool_call_result` frame; the
      // top-level `attachments` array (typed as unknown here because
      // ToolCallResultFrame doesn't enumerate it — see HitlAttachment in
      // types.ts) is summarised the same way as in http_bridge.ts's WS
      // handler so both audit emissions for this event carry consistent
      // attachment metadata.
      const { count: attachmentCount, bytes: attachmentBytes } =
        summariseAttachments((result as { attachments?: unknown }).attachments);
      void appendAudit({
        ts: new Date().toISOString(),
        instance_id: identity.instanceId,
        direction: "phone_returns_to_cc",
        kind: "tool_result",
        tool_name: name,
        approval: result.approval ?? null,
        prompt_hash: sha256Hex(JSON.stringify(result.output ?? null)),
        duration_ms: duration,
        attachment_count: attachmentCount,
        attachment_bytes: attachmentBytes,
      });
      if (result.success === false) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: result.error ?? "unknown_error",
                  approval: result.approval ?? null,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: true,
              output: result.output ?? null,
              approval: result.approval ?? null,
              attachment_count: attachmentCount,
              attachment_bytes: attachmentBytes,
            },
            null,
            2,
          ),
        },
      ];
      const rawAttachments = (result as { attachments?: unknown }).attachments;
      if (Array.isArray(rawAttachments)) {
        for (const att of rawAttachments) {
          if (
            att != null &&
            typeof att === "object" &&
            typeof (att as { type?: unknown }).type === "string" &&
            (att as { type: string }).type === "image" &&
            typeof (att as { data?: unknown }).data === "string" &&
            typeof (att as { media_type?: unknown }).media_type === "string"
          ) {
            const a = att as { data: string; media_type: string };
            content.push({
              type: "image" as const,
              data: a.data,
              mimeType: a.media_type,
            });
          }
        }
      }
      return { content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `call_phone_tool failed: ${msg}`,
          },
        ],
      };
    }
  }

  throw new Error(`Unknown tool: ${req.params.name}`);
});

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
