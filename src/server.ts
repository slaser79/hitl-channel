#!/usr/bin/env bun
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
import { startMDNS } from "./mdns.js";
import { cleanupExpiredPairings } from "./pairing.js";
import {
  appendAudit,
  pruneOldAuditFiles,
  sha256Hex,
} from "./audit.js";
import type {
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
        "Pass the message_id from the inbound channel tag for threading.",
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

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const identity = await getIdentity();

  if (req.params.name === "reply_to_hitl") {
    const text = args.text as string;
    const messageId = args.message_id as string | undefined;
    const agentId = args.agent_id as string | undefined;

    process.stderr.write(
      `[hitl-channel] Reply: ${text} (msg: ${messageId}, agent: ${agentId})\n`
    );

    broadcastReply(text, messageId, agentId);
    void appendAudit({
      ts: new Date().toISOString(),
      instance_id: identity.instanceId,
      direction: "cc_to_phone",
      kind: "reply",
      tool_name: null,
      approval: null,
      prompt_hash: sha256Hex(text ?? ""),
      duration_ms: null,
    });

    return {
      content: [{ type: "text" as const, text: `Sent to HITL app: ${text}` }],
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
      void appendAudit({
        ts: new Date().toISOString(),
        instance_id: identity.instanceId,
        direction: "phone_returns_to_cc",
        kind: "tool_result",
        tool_name: name,
        approval: result.approval ?? null,
        prompt_hash: sha256Hex(JSON.stringify(result.output ?? null)),
        duration_ms: duration,
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
setInterval(() => {
  cleanupExpiredPairings();
}, 60000);

await mcp.connect(new StdioServerTransport());

startHttpBridge(mcp);
