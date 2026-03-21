#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { startHttpBridge, broadcastReply } from "./http_bridge.js";
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

  throw new Error(`Unknown tool: ${req.params.name}`);
});

// Initialize instance identity and start services
const identity = await getIdentity();
process.stderr.write(
  `[hitl-channel] HITL Channel server listening on http://0.0.0.0:${PORT}\n`
);
process.stderr.write(`[hitl-channel] Instance ID: ${identity.instanceId}\n`);

// Start mDNS advertising
startMDNS(PORT, identity.instanceId);

// Start periodic cleanup of expired pairing codes (every minute)
setInterval(() => {
  cleanupExpiredPairings();
}, 60000);

await mcp.connect(new StdioServerTransport());

startHttpBridge(mcp);
