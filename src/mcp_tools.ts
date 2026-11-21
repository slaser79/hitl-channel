import { readFile, stat, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, extname, resolve as resolvePath } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  broadcastReply,
  unicastFrame,
  unicastCorrelatedFrame,
  getMostRecentlyActiveClient,
  correlator,
  clients,
} from "./http_bridge.js";
import { getIdentity } from "./identity.js";
import {
  appendAudit,
  sha256Hex,
  stableStringify,
  summariseAttachments,
} from "./audit.js";
import type {
  HitlAttachment,
  ListToolsResultFrame,
  ToolCallResultFrame,
} from "./types.js";
import {
  PRESENT_QUESTIONS_TOOL_DEFINITION,
  presentQuestionsToHitl,
} from "./questions_batch.js";

export type HitlToolsMode = "channel" | "daemon";

export interface RegisterHitlToolsOptions {
  mode: HitlToolsMode;
  requestAcpSessionId?: string | null;
  getFallbackAcpSessionId?: () => string | null;
  onChoicesPresented?: () => void;
  onReplySent?: (acpSessionId?: string | null) => void;
}

function resolveDaemonAcpSessionId(
  rawConvId: unknown,
  options: RegisterHitlToolsOptions,
): string | null {
  if (typeof rawConvId === "string" && rawConvId.length > 0) {
    return rawConvId;
  }
  if (
    typeof options.requestAcpSessionId === "string" &&
    options.requestAcpSessionId.length > 0
  ) {
    return options.requestAcpSessionId;
  }
  const fallback = options.getFallbackAcpSessionId?.();
  if (typeof fallback === "string" && fallback.length > 0) {
    return fallback;
  }
  return null;
}

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
export const kMaxFileReadBytes = 5 * 1024 * 1024;

// Allowlist of directory prefixes a `path` attachment may resolve under.
// Defaults to the user's home directory + tmpdir; an operator can widen
// or narrow via HITL_CHANNEL_ATTACHMENT_ROOTS (colon-separated absolute
// paths). The check uses `path.resolve` to normalise away `..` segments
// before the prefix match so a caller can't escape via `~/../etc/passwd`.
export function attachmentRoots(): string[] {
  const env = process.env.HITL_CHANNEL_ATTACHMENT_ROOTS;
  let rawRoots: string[];
  if (env && env.trim().length > 0) {
    rawRoots = env
      .split(":")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => resolvePath(p));
  } else {
    rawRoots = [resolvePath(homedir()), resolvePath(tmpdir()), resolvePath("/tmp")];
  }

  const roots: string[] = [];
  for (const r of rawRoots) {
    roots.push(r);
    try {
      const resolved = realpathSync(r);
      if (resolved !== r) {
        roots.push(resolved);
      }
    } catch {
      // ignore
    }
  }
  return roots;
}

export function isPathAllowed(absolute: string, roots: string[]): boolean {
  for (const root of roots) {
    if (absolute === root) return true;
    // Append a separator to the root so /home/foo doesn't match /home/foobar.
    const prefix = root.endsWith("/") ? root : root + "/";
    if (absolute.startsWith(prefix)) return true;
  }
  return false;
}

export async function resolveAttachments(raw: unknown): Promise<{
  attachments: HitlAttachment[];
  warnings: string[];
}> {
  if (!Array.isArray(raw)) return { attachments: [], warnings: [] };
  const roots = attachmentRoots();
  const out: HitlAttachment[] = [];
  const warnings: string[] = [];
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
      let realAbsolute: string;
      try {
        realAbsolute = await realpath(absolute);
      } catch (err) {
        process.stderr.write(
          `[hitl-channel] reply_to_hitl: failed to resolve realpath for ${absolute}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
        warnings.push(`failed to resolve path: ${a.path}`);
        continue;
      }

      if (!isPathAllowed(realAbsolute, roots)) {
        process.stderr.write(
          `[hitl-channel] reply_to_hitl: rejecting path outside allowlisted roots: ${realAbsolute}\n`,
        );
        warnings.push(`path outside allowlist: ${a.path}`);
        continue;
      }
      try {
        const st = await stat(realAbsolute);
        if (!st.isFile()) {
          process.stderr.write(
            `[hitl-channel] reply_to_hitl: path is not a regular file: ${realAbsolute}\n`,
          );
          warnings.push(`path is not a regular file: ${a.path}`);
          continue;
        }
        if (st.size > kMaxFileReadBytes) {
          process.stderr.write(
            `[hitl-channel] reply_to_hitl: attachment_too_large size=${st.size} max=${kMaxFileReadBytes} path=${realAbsolute}\n`,
          );
          warnings.push(`file size exceeds limit: ${a.path}`);
          continue;
        }
        const buf = await readFile(realAbsolute);
        data = buf.toString("base64");
        if (!fileName) fileName = basename(realAbsolute);
        if (!mediaType) {
          const ext = extname(realAbsolute).slice(1).toLowerCase();
          mediaType = MIME_BY_EXT[ext] ?? "application/octet-stream";
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[hitl-channel] reply_to_hitl: failed to read ${realAbsolute}: ${errMsg}\n`,
        );
        warnings.push(`failed to read: ${a.path}`);
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
  return { attachments: out, warnings };
}

const CHANNEL_REPLY_TO_HITL_DESCRIPTION =
  "Send a reply message back to the HITL mobile app user. " +
  "Pass the message_id from the inbound channel tag for threading. " +
  "Optionally include image/file attachments — they render inline " +
  "on the phone CC chat (images = thumbnail + tap-to-zoom; other " +
  "mime types = filename chip).";

const DAEMON_REPLY_TO_HITL_SUFFIX =
  " Interim updates / attachments only; your turn text is delivered automatically; message_id is ignored.";

export function getHitlToolDefinitions(mode: HitlToolsMode) {
  return [
    {
      name: "reply_to_hitl",
      description:
        mode === "daemon"
          ? CHANNEL_REPLY_TO_HITL_DESCRIPTION + DAEMON_REPLY_TO_HITL_SUFFIX
          : CHANNEL_REPLY_TO_HITL_DESCRIPTION,
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
      name: "list_devices",
      description: "List currently connected HITL mobile devices and their status.",
      inputSchema: {
        type: "object",
        properties: {},
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
          device: {
            type: "string",
            description: "Optional device token hash or device ID to target a specific connected phone.",
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
          device: {
            type: "string",
            description: "Optional device token hash or device ID to target a specific connected phone.",
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
          device: {
            type: "string",
            description: "Optional device token hash or device ID to target a specific connected phone.",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "push_file",
      description:
        "Push a text file from the console filesystem to the phone's app storage. " +
        "Gates the push on-device via a softConfirm approval sheet. Only text files are supported.",
      inputSchema: {
        type: "object",
        properties: {
          local_path: {
            type: "string",
            description: "Absolute or relative path to the local file on the console.",
          },
          dest: {
            type: "string",
            description:
              "Rooted relative path on the phone's storage (e.g. 'skills/my-skill/scripts/board.html', 'documents/notes.txt'). " +
              "Must be relative/rooted (no arbitrary absolute paths).",
          },
          media_type: {
            type: "string",
            description: "Optional MIME type. If omitted, inferred from the file extension.",
          },
          overwrite: {
            type: "boolean",
            description: "Whether to overwrite the file on the phone if it already exists (default: true).",
          },
          device: {
            type: "string",
            description: "Optional device token hash or device ID to target a specific connected phone.",
          },
        },
        required: ["local_path", "dest"],
      },
    },
    // ─── SPEC-HC-004 ─────────────────────────────────────────────────────
    PRESENT_QUESTIONS_TOOL_DEFINITION,
  ];
}

export function registerHitlTools(
  server: Server,
  options: RegisterHitlToolsOptions,
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getHitlToolDefinitions(options.mode),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const rawMeta =
      (extra as { _meta?: Record<string, unknown> } | undefined)?._meta ??
      (req.params as { _meta?: Record<string, unknown> })._meta;
    const rawConvId = rawMeta?.["antigravity.google/conversation_id"];
    const acpSessionId: string | null | undefined =
      options.mode === "daemon"
        ? resolveDaemonAcpSessionId(rawConvId, options)
        : undefined;
    const acpAuditField =
      acpSessionId !== undefined ? { acp_session_id: acpSessionId } : {};

    if (req.params.name === "reply_to_hitl") {
      const text = args.text as string;
      // SPEC-HC-005 §4.1/AV7/AV9 — in daemon mode message_id is always
      // stripped so only the end-of-turn reply can resolve a delegation.
      const messageId =
        options.mode === "daemon"
          ? undefined
          : (args.message_id as string | undefined);
      const agentId = args.agent_id as string | undefined;
      const rawAttachments = args.attachments;
      const { attachments, warnings } = await resolveAttachments(
        rawAttachments,
      );
      const { count: attachmentCount, bytes: attachmentBytes } =
        summariseAttachments(attachments);

      process.stderr.write(
        `[hitl-channel] Reply: ${text} (msg: ${messageId}, agent: ${agentId}, attachments: ${attachmentCount})\n`
      );

      broadcastReply(text, messageId, agentId, attachments);
      options.onReplySent?.(acpSessionId);
      const identity = await getIdentity();
      appendAudit({
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
        ...acpAuditField,
      }).catch((err) =>
        process.stderr.write(
          `[hitl-channel] audit failed: ${err instanceof Error ? err.message : err}\n`
        )
      );

      let responseText = `Sent to HITL app: ${text} (attachments: ${attachmentCount})`;
      if (warnings.length > 0) {
        const isPlural = warnings.length > 1;
        responseText += ` (${warnings.length} attachment${isPlural ? "s" : ""} dropped: ${warnings.join(", ")})`;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: responseText,
          },
        ],
      };
    }

    if (req.params.name === "list_devices") {
      const openClients = Array.from(clients).filter((ws) => ws.readyState === 1);
      const mostActive = getMostRecentlyActiveClient();
      const deviceList = openClients.map((ws) => {
        const tokenHash = ws.data?.tokenHash ?? "unknown";
        return {
          token_hash: tokenHash,
          device_id: tokenHash,
          connected_at: ws.data?.connectedAt ?? null,
          last_seen: ws.data?.lastSeen ?? null,
          is_active: ws === mostActive,
        };
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ devices: deviceList }, null, 2),
          },
        ],
      };
    }

    if (req.params.name === "present_choices_to_hitl") {
      const prompt = args.prompt as string;
      const choices = args.choices as string[];
      const multiSelect = args.multi_select as boolean | undefined;
      const targetDevice = args.device as string | undefined;

      process.stderr.write(
        `[hitl-channel] Choices: ${prompt} [${choices.join(", ")}] (multi: ${multiSelect ?? false})\n`
      );

      const frame = {
        type: "choices",
        content: prompt,
        choices: choices,
        multiSelect: multiSelect ?? false,
        id: `c${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
      };

      const unicastResult = unicastFrame(frame, targetDevice);
      if (!unicastResult.delivered) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `present_choices_to_hitl failed: ${unicastResult.error ?? "no_phone_connected"}`,
            },
          ],
        };
      }

      options.onChoicesPresented?.();

      const identity = await getIdentity();
      appendAudit({
        ts: new Date().toISOString(),
        instance_id: identity.instanceId,
        direction: "cc_to_phone",
        kind: "choices",
        tool_name: null,
        approval: null,
        prompt_hash: sha256Hex(prompt ?? ""),
        duration_ms: null,
        attachment_count: 0,
        attachment_bytes: 0,
        device_id: unicastResult.targetDevice ?? null,
        ...acpAuditField,
      }).catch((err) =>
        process.stderr.write(
          `[hitl-channel] audit failed: ${err instanceof Error ? err.message : err}\n`
        )
      );

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
      const targetDevice = args.device as string | undefined;
      const requestId = generateRequestId();
      const frame = {
        type: "list_tools_request" as const,
        request_id: requestId,
        ...(filter ? { filter } : {}),
      };
      const unicastResult = unicastCorrelatedFrame<ListToolsResultFrame>(
        frame,
        requestId,
        30_000,
        targetDevice,
      );
      if (!unicastResult.delivered) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `list_phone_tools failed: ${unicastResult.error ?? "no_phone_connected"}`,
            },
          ],
        };
      }
      const waiter = unicastResult.waiter;
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
      const targetDevice = args.device as string | undefined;
      const identity = await getIdentity();
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

      const unicastResult = unicastCorrelatedFrame<ToolCallResultFrame>(
        frame,
        requestId,
        timeoutSeconds * 1000,
        targetDevice,
      );
      if (!unicastResult.delivered) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `call_phone_tool failed: ${unicastResult.error ?? "no_phone_connected"}`,
            },
          ],
        };
      }
      const waiter = unicastResult.waiter;

      appendAudit({
        ts: new Date(startedAt).toISOString(),
        instance_id: identity.instanceId,
        direction: "cc_calls_phone",
        kind: "tool_call",
        tool_name: name,
        approval: null,
        prompt_hash: sha256Hex(stableStringify(toolArgs)),
        duration_ms: null,
        attachment_count: 0,
        attachment_bytes: 0,
        device_id: unicastResult.targetDevice ?? null,
        ...acpAuditField,
      }).catch((err) =>
        process.stderr.write(
          `[hitl-channel] audit failed: ${err instanceof Error ? err.message : err}\n`
        )
      );

      try {
        const result = await waiter;
        const duration = Date.now() - startedAt;
        const { count: attachmentCount, bytes: attachmentBytes } =
          summariseAttachments((result as { attachments?: unknown }).attachments);
        appendAudit({
          ts: new Date().toISOString(),
          instance_id: identity.instanceId,
          direction: "phone_returns_to_cc",
          kind: "tool_result",
          tool_name: name,
          approval: result.approval ?? null,
          prompt_hash: sha256Hex(stableStringify(result.output ?? null)),
          duration_ms: duration,
          attachment_count: attachmentCount,
          attachment_bytes: attachmentBytes,
          device_id: unicastResult.targetDevice ?? null,
          ...acpAuditField,
        }).catch((err) =>
          process.stderr.write(
            `[hitl-channel] audit failed: ${err instanceof Error ? err.message : err}\n`
          )
        );
        if (result.success === false) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: false,
                    data: result.data ?? null,
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
                data: result.data ?? null,
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
        const duration = Date.now() - startedAt;
        const msg = err instanceof Error ? err.message : String(err);
        const isTimeout = msg.includes("timeout");

        appendAudit({
          ts: new Date().toISOString(),
          instance_id: identity.instanceId,
          direction: "phone_returns_to_cc",
          kind: "tool_result",
          tool_name: name,
          approval: isTimeout ? "timeout" : null,
          prompt_hash: sha256Hex(stableStringify(toolArgs)),
          duration_ms: duration,
          attachment_count: 0,
          attachment_bytes: 0,
          device_id: unicastResult.targetDevice ?? null,
          ...acpAuditField,
        }).catch((auditErr) =>
          process.stderr.write(
            `[hitl-channel] audit failed: ${auditErr instanceof Error ? auditErr.message : auditErr}\n`
          )
        );

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

    if (req.params.name === "push_file") {
      const localPath = args.local_path as string | undefined;
      const dest = args.dest as string | undefined;
      const _overwrite = args.overwrite as boolean | undefined;
      const _mediaType = args.media_type as string | undefined;
      void _overwrite;
      void _mediaType;

      if (!localPath || typeof localPath !== "string") {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "push_file requires `local_path` (string).",
            },
          ],
        };
      }
      if (!dest || typeof dest !== "string") {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "push_file requires `dest` (string).",
            },
          ],
        };
      }

      // Host-path validation
      const absolute = resolvePath(localPath);
      let realAbsolute: string;
      try {
        realAbsolute = await realpath(absolute);
      } catch (err) {
        process.stderr.write(
          `[hitl-channel] push_file: failed to resolve realpath for ${absolute}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `push_file failed: failed to resolve path: ${localPath}`,
            },
          ],
        };
      }
      const roots = attachmentRoots();
      if (!isPathAllowed(realAbsolute, roots)) {
        process.stderr.write(
          `[hitl-channel] push_file: rejecting path outside allowlisted roots: ${realAbsolute}\n`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `push_file failed: path outside allowlist: ${localPath}`,
            },
          ],
        };
      }

      // Verify it is a file and meets size constraints
      try {
        const st = await stat(realAbsolute);
        if (!st.isFile()) {
          process.stderr.write(
            `[hitl-channel] push_file: path is not a regular file: ${realAbsolute}\n`,
          );
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `push_file failed: path is not a regular file: ${localPath}`,
              },
            ],
          };
        }
        if (st.size > kMaxFileReadBytes) {
          process.stderr.write(
            `[hitl-channel] push_file: file size exceeds limit: ${realAbsolute}\n`,
          );
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `push_file failed: file size exceeds limit: ${localPath}`,
              },
            ],
          };
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[hitl-channel] push_file: failed to read metadata for ${realAbsolute}: ${errMsg}\n`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `push_file failed: failed to read: ${localPath}`,
            },
          ],
        };
      }

      // Destination validation
      const normalizedDest = dest.replace(/\\/g, "/").replace(/^\/+/, "");
      const destParts = normalizedDest.split("/");
      if (destParts.includes("..") || destParts.includes(".") || normalizedDest === "") {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `push_file failed: invalid destination path (must be relative and cannot contain .. or .): ${dest}`,
            },
          ],
        };
      }

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

      // Read the local file content as text
      let fileContent: string;
      try {
        fileContent = await readFile(realAbsolute, "utf8");
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[hitl-channel] push_file: failed to read file ${realAbsolute}: ${errMsg}\n`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `push_file failed: failed to read file contents: ${localPath}`,
            },
          ],
        };
      }

      // Determine target phone tool and build arguments.
      // NOTE: argument keys must match the on-device InternalToolsService
      // schemas EXACTLY (verified via list_phone_tools). write_skill_file is
      // additionalProperties:false, so extra keys are rejected — do not add
      // alias keys or media-type hints here.
      let phoneToolName = "write_file";
      let phoneToolArgs: Record<string, unknown> = {};

      const parts = normalizedDest.split("/");
      if (parts[0] === "skills" && parts.length >= 3) {
        // write_skill_file requires exactly: name, file_path, content
        phoneToolName = "write_skill_file";
        const skillName = parts[1];
        const filePath = parts.slice(2).join("/");
        phoneToolArgs = {
          name: skillName,
          file_path: filePath,
          content: fileContent,
        };
      } else {
        // write_file requires: filename, content
        phoneToolName = "write_file";
        phoneToolArgs = {
          filename: normalizedDest,
          content: fileContent,
        };
      }

      const targetDevice = args.device as string | undefined;
      const identity = await getIdentity();
      const timeoutSeconds = 60;
      const requestId = generateRequestId();
      const frame = {
        type: "tool_call_request" as const,
        request_id: requestId,
        name: phoneToolName,
        arguments: phoneToolArgs,
        timeout_seconds: timeoutSeconds,
        cc_instance_id: identity.instanceId,
      };
      const startedAt = Date.now();
      const inputHash = sha256Hex(stableStringify(phoneToolArgs));

      const unicastResult = unicastCorrelatedFrame<ToolCallResultFrame>(
        frame,
        requestId,
        timeoutSeconds * 1000,
        targetDevice,
      );
      if (!unicastResult.delivered) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `push_file failed: ${unicastResult.error ?? "no_phone_connected"}`,
            },
          ],
        };
      }
      const waiter = unicastResult.waiter;

      // Audit the outgoing call
      appendAudit({
        ts: new Date(startedAt).toISOString(),
        instance_id: identity.instanceId,
        direction: "cc_calls_phone",
        kind: "tool_call",
        tool_name: phoneToolName,
        approval: null,
        prompt_hash: inputHash,
        duration_ms: null,
        attachment_count: 0,
        attachment_bytes: 0,
        device_id: unicastResult.targetDevice ?? null,
        ...acpAuditField,
      }).catch((err) =>
        process.stderr.write(
          `[hitl-channel] audit failed: ${err instanceof Error ? err.message : err}\n`,
        )
      );

      try {
        const result = await waiter;
        const duration = Date.now() - startedAt;

        // Audit the incoming result
        const { count: attachmentCount, bytes: attachmentBytes } =
          summariseAttachments((result as { attachments?: unknown }).attachments);

        appendAudit({
          ts: new Date().toISOString(),
          instance_id: identity.instanceId,
          direction: "phone_returns_to_cc",
          kind: "tool_result",
          tool_name: phoneToolName,
          approval: result.approval ?? null,
          prompt_hash: inputHash, // Repeat original request's prompt_hash for correlation
          duration_ms: duration,
          attachment_count: attachmentCount,
          attachment_bytes: attachmentBytes,
          device_id: unicastResult.targetDevice ?? null,
          ...acpAuditField,
        }).catch((err) =>
          process.stderr.write(
            `[hitl-channel] audit failed: ${err instanceof Error ? err.message : err}\n`,
          )
        );

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

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  output: result.output ?? null,
                  approval: result.approval ?? null,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const duration = Date.now() - startedAt;
        const msg = err instanceof Error ? err.message : String(err);

        // Audit the failure path
        appendAudit({
          ts: new Date().toISOString(),
          instance_id: identity.instanceId,
          direction: "phone_returns_to_cc",
          kind: "tool_result",
          tool_name: phoneToolName,
          approval: msg.includes("timeout") ? "timeout" : null,
          prompt_hash: inputHash, // Repeat original request's prompt_hash for correlation
          duration_ms: duration,
          attachment_count: 0,
          attachment_bytes: 0,
          device_id: unicastResult.targetDevice ?? null,
          ...acpAuditField,
        }).catch((auditErr) =>
          process.stderr.write(
            `[hitl-channel] audit failed: ${auditErr instanceof Error ? auditErr.message : auditErr}\n`,
          )
        );

        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `push_file failed: ${msg}`,
            },
          ],
        };
      }
    }

    if (req.params.name === "present_questions_to_hitl") {
      const identity = await getIdentity();
      return presentQuestionsToHitl(args, {
        correlator,
        unicastFrame,
        clientsSize: () => clients.size,
        instanceId: identity.instanceId,
        generateRequestId,
        ...(acpSessionId !== undefined ? { acpSessionId } : {}),
      });
    }

    throw new Error(`Unknown tool: ${req.params.name}`);
  });
}
