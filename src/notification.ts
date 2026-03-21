import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ChannelMeta } from "./types.js";

let msgSeq = 0;

export async function sendChannelNotification(
  mcp: Server,
  content: string,
  meta: Record<string, string> = {}
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

  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content,
      meta: channelMeta,
    },
  });
}
