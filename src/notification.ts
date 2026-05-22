import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ChannelMeta } from "./types.js";

let msgSeq = 0;

export async function sendChannelNotification(
  mcp: Server,
  content: string,
  meta: Record<string, any> = {}
): Promise<void> {
  const senderId = meta.sender_id || "unknown";
  const agentId = meta.agent_id;

  const channelMeta: ChannelMeta = {
    message_id: `m${Date.now()}-${++msgSeq}`,
    ts: new Date().toISOString(),
    sender_id: senderId,
    ...meta,
  };

  if (agentId) {
    channelMeta.agent_id = agentId;
  }

  // Ensure all meta values are strings for MCP attributes
  const serializedMeta: Record<string, string> = {};
  for (const [key, value] of Object.entries(channelMeta)) {
    if (value === undefined) continue;
    serializedMeta[key] = typeof value === "string" ? value : JSON.stringify(value);
  }

  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content,
      meta: serializedMeta,
    },
  });
}
