---
id: SPEC-HC-003
title: "Claude Code Channel Messaging"
status: "Complete"
owner: "hitl-channel"
last_updated: 2026-03-22
---

# Claude Code Channel Messaging

## Overview

hitl-channel uses the experimental MCP channel protocol (`notifications/claude/channel`) to push messages directly into a Claude Code session. This enables real-time bidirectional communication between the mobile app and Claude.

## Message Flow

### Inbound (Mobile App → Claude Code)

1. Mobile app sends `POST /` with message
2. HTTP bridge receives and validates token
3. Bridge calls `sendChannelNotification(mcp, content, meta)`
4. MCP SDK sends `notifications/claude/channel` to Claude Code
5. Claude Code displays message with `<channel>` tag

### Outbound (Claude Code → Mobile App)

1. Claude Code calls `reply_to_hitl` tool
2. Tool handler calls `broadcastReply(text, messageId, agentId)`
3. Bridge sends JSON payload to all connected WebSocket clients
4. Mobile app receives and displays reply

## Protocol Details

### Channel Notification Format

```typescript
mcp.notification({
  method: "notifications/claude/channel",
  params: {
    content: "Hello from mobile!",
    meta: {
      message_id: "m1711234567890-1",
      ts: "2026-03-22T10:00:00.000Z",
      sender_id: "ceo",
      agent_id: "my-workstation",
    },
  },
});
```

### Reply Tool Schema

```json
{
  "name": "reply_to_hitl",
  "description": "Send a reply message back to the HITL mobile app user",
  "inputSchema": {
    "type": "object",
    "properties": {
      "text": { "type": "string", "description": "The reply text" },
      "message_id": { "type": "string", "description": "Optional message ID for threading" },
      "agent_id": { "type": "string", "description": "Optional agent identity" }
    },
    "required": ["text"]
  }
}
```

### WebSocket Reply Format

```json
{
  "type": "reply",
  "text": "I've completed the task.",
  "content": "I've completed the task.",
  "id": "r1711234567890-abc123",
  "message_id": "m1711234567890-1",
  "agent_id": "my-workstation",
  "ts": "2026-03-22T10:00:05.000Z"
}
```

## Attachment Support

Images sent from mobile app are:
1. Base64-decoded
2. Saved to `~/.claude/channels/hitl-channel/inbox/`
3. File path appended to message: `[Image: /path/to/image.jpg]`

```typescript
const contentForNotification = await processAttachments(message, attachments);
// contentForNotification = "Check this out\n\n[Image: ~/.claude/channels/hitl-channel/inbox/img_123.jpg]"
```

## Server Instructions

The MCP server provides these instructions to Claude Code:

> Messages from the HITL mobile app arrive as `<channel source="hitl-channel" sender_id="..." message_id="...">`. Use the reply_to_hitl tool to send responses back to the mobile app user. The sender_id indicates who sent the message (e.g., 'ceo', 'xo').

## Files

- `src/server.ts`: MCP server and tool registration
- `src/notification.ts`: `sendChannelNotification()` helper
- `src/http_bridge.ts`: HTTP/WS bridge, `broadcastReply()`
- `src/types.ts`: Message and reply interfaces

## Acceptance Criteria

- [x] Messages appear in Claude Code with channel tag
- [x] `sender_id` preserved in metadata
- [x] `message_id` generated for each message
- [x] `reply_to_hitl` tool registered and functional
- [x] Replies broadcast to all WebSocket clients
- [x] Image attachments saved and path included
