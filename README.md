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

## Daemon mode

Run `hitl-channel` as a long-lived daemon to drive non-Claude ACP harnesses (Antigravity `agy` in Phase 1) directly from the HITL phone over LAN or Tailscale, without a cloud intermediary:

```bash
# Default port 8790, display name agy@<hostname>
bun run src/cli.ts daemon --harness agy
# or directly:
bun run src/daemon.ts --harness agy --port 8790 --cwd ~/lab/hitl
```

### CLI Options

| Flag | Default | Description |
|---|---|---|
| `--harness <name>` | `agy` | ACP harness to spawn (`agy` in Phase 1) |
| `--port <port>` | `8790` (or `HITL_CHANNEL_PORT`) | HTTP/WS bridge listen port |
| `--name <displayName>` | `<harness>@<hostname>` | Override instance display name |
| `--cwd <dir>` | current working directory | Default directory for auto-created / `/new` sessions |

### Phone Chat Slash Commands

- `/help` — show supported daemon commands
- `/new [harness] [cwd]` — create and switch to a new session (default cwd if omitted; Phase 1 harness: `agy`)
- `/sessions` — list the 10 most recent sessions with title, folder, and relative time
- `/resume <n|id>` — resume a session from `/sessions` (or by session ID)
- `/cancel` — cancel any pending approval cards and stop the active turn
- `/status` — show harness, active session, running state, queue depth, and pending approvals

### Daemon Identity & Storage

- Identity is stored separately from channel mode at `~/.hitl/channels/identity-daemon-<harness>.json` (override with `HITL_CHANNEL_IDENTITY_FILE`), so a daemon and a Claude Code channel session on the same host advertise distinct `instanceId`s.
- Paired device tokens are shared in `~/.hitl/channels/allowlist.json` (SHA-256 hashed).
- Pairing codes are printed to `stdout` and surfaced via a local desktop notification (`osascript` on macOS, `notify-send` on Linux).

### Running at Login on macOS (`launchd`)

Save a plist such as `~/Library/LaunchAgents/com.hitl-channel.daemon.agy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hitl-channel.daemon.agy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/bun</string>
    <string>run</string>
    <string>/path/to/hitl-channel/src/daemon.ts</string>
    <string>--harness</string>
    <string>agy</string>
    <string>--port</string>
    <string>8790</string>
    <string>--cwd</string>
    <string>/Users/you/workspace</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/hitl-channel-daemon-agy.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/hitl-channel-daemon-agy.err.log</string>
</dict>
</plist>
```

Load it with `launchctl load ~/Library/LaunchAgents/com.hitl-channel.daemon.agy.plist`.

### Wire Smoke (`agy acp`)

```bash
python3 scripts/acp_smoke.py
```

## Related Projects

- [hitl-cli](https://github.com/slaser79/hitl-cli) — Python CLI/SDK for relay-based HITL (via hitlrelay.app)
- [hitl-app](https://hitlrelay.app) — HITL mobile app (iOS/Android)

## License

MIT
