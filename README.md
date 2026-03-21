# hitl-channel

**Claude Code MCP channel plugin for direct mobile-to-agent communication.**

hitl-channel is a TypeScript MCP server that enables bidirectional communication between the [HITL mobile app](https://hitlrelay.app) and Claude Code sessions — with no cloud intermediary. Messages travel directly over your LAN or Tailscale network.

## Features

- **Privacy-first**: Direct LAN/Tailscale connection, no relay server
- **Claude Code Channels**: Native MCP channel protocol (`notifications/claude/channel`)
- **Pairing flow**: Secure 6-digit code pairing with device token allowlist
- **mDNS discovery**: Auto-discovery on local network (`_hitl-channel._tcp`)
- **WebSocket bridge**: Real-time bidirectional messaging
- **Multi-instance**: Support multiple Claude Code sessions with distinct identities

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) (recommended) or Node.js 20+
- Claude Code v2.1.80+ (channels require research preview)

### Install

```bash
# Clone
git clone https://github.com/slaser79/hitl-channel.git
cd hitl-channel
bun install
```

### Configure Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "hitl-channel": {
      "command": "bun",
      "args": ["run", "/path/to/hitl-channel/src/server.ts"],
      "env": {
        "HITL_CHANNEL_PORT": "8789"
      }
    }
  }
}
```

### Start Claude Code with Channels

```bash
claude --dangerously-load-development-channels server:hitl-channel
```

### Connect from HITL App

1. Open HITL app on your phone
2. Go to Agents > Claude Code > Add Instance
3. Enter your machine's IP and port 8789 (or discover via mDNS on same network)
4. Tap "Pair" — a 6-digit code will appear in your Claude Code session
5. Enter the code in the app
6. Start chatting!

## Architecture

```
hitl-app (phone)
    │
    ├── HTTP POST /           → Send messages to Claude Code
    ├── POST /pair/request    → Initiate pairing (code sent via channel notification)
    ├── POST /pair/validate   → Validate code, receive device token
    └── WebSocket /ws         → Receive replies from Claude Code
          │
          ▼
hitl-channel (MCP server, port 8789)
    │
    ├── channel notification  → Push messages into Claude Code session
    └── reply_to_hitl tool    → Claude Code sends replies back
          │
          ▼
Claude Code (your terminal)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HITL_CHANNEL_PORT` | `8789` | HTTP/WebSocket bridge port |
| `HITL_CHANNEL_API_KEY` | (none) | Legacy API key auth (optional) |

## Data Storage

Identity and allowlist are stored in `~/.hitl/channels/`:

- `identity.json` — Instance ID (stable across restarts)
- `allowlist.json` — Paired device token hashes (SHA-256)

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check (status, port, client count) |
| `/instance` | GET | No | Instance identity (instanceId, hostname) |
| `/pair/request` | POST | No | Request pairing code (sent to Claude Code via channel) |
| `/pair/validate` | POST | No | Validate code, returns device token |
| `/` | POST | Yes | Send message to Claude Code |
| `/ws` | GET | Yes | WebSocket for receiving replies |

## Development

```bash
# Run tests
bun test

# Start standalone (for development)
bun src/server.ts
```

## Related Projects

- [hitl-cli](https://github.com/slaser79/hitl-cli) — Python CLI/SDK for relay-based HITL (via hitlrelay.app)
- [hitl-app](https://hitlrelay.app) — HITL mobile app (iOS/Android)

## License

MIT
