#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { startHttpBridge, broadcastReply, clients } from "./http_bridge.js";
import { getIdentity } from "./identity.js";
import { startMDNS } from "./mdns.js";
import { cleanupExpiredPairings } from "./pairing.js";

const PORT = Number(process.env.HITL_CHANNEL_PORT ?? 8789);

const mcp = new Server(
  { name: "hitl-channel", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      'Messages from the HITL mobile app arrive as <channel source="hitl-channel" sender_id="..." message_id="...">.',
      "Use the reply_to_hitl tool to send responses back to the mobile app user.",
      "The sender_id indicates who sent the message (e.g., 'ceo', 'xo').",
    ].join(" "),
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
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  if (req.params.name === "reply_to_hitl") {
    const text = args.text as string;
    const messageId = args.message_id as string | undefined;
    const agentId = args.agent_id as string | undefined;

    process.stderr.write(
      `[hitl-channel] Reply: ${text} (msg: ${messageId}, agent: ${agentId})\n`
    );

    broadcastReply(text, messageId, agentId);

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

    // Broadcast choices to connected apps via WebSocket
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

    return {
      content: [{ type: "text" as const, text: `Choices presented to user: ${choices.join(", ")}` }],
    };
  }

  throw new Error(`Unknown tool: ${req.params.name}`);
});

// Initialize instance identity and start services
const identity = await getIdentity();
process.stderr.write(
  `[hitl-channel] HITL Channel server listening on http://0.0.0.0:${PORT}\n`
);
process.stderr.write(`[hitl-channel] Instance ID: ${identity.instanceId}\n`);
process.stderr.write(`[hitl-channel] Display Name: ${identity.displayName}\n`);

// Start mDNS advertising
startMDNS(PORT, identity.instanceId, identity.displayName);

// Start periodic cleanup of expired pairing codes (every minute)
setInterval(() => {
  cleanupExpiredPairings();
}, 60000);

await mcp.connect(new StdioServerTransport());

startHttpBridge(mcp);
