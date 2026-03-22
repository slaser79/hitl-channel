# CLAUDE.md - hitl-channel

## Project Overview

hitl-channel is a TypeScript MCP server that enables direct bidirectional communication between the HITL mobile app and Claude Code sessions. It provides a privacy-first alternative to cloud relays by routing messages over LAN or Tailscale.

## Quick Start

```bash
# Install dependencies
bun install

# Run tests
bun test

# Start standalone (development)
bun src/server.ts

# Configure Claude Code (add to .mcp.json)
{
  "mcpServers": {
    "hitl-channel": {
      "command": "bun",
      "args": ["run", "/path/to/hitl-channel/src/server.ts"],
      "env": { "HITL_CHANNEL_PORT": "8789" }
    }
  }
}
```

## Architecture

- **MCP Server** (`src/server.ts`): Registers `reply_to_hitl` tool, handles channel notifications
- **HTTP Bridge** (`src/http_bridge.ts`): REST API + WebSocket for mobile app
- **Pairing** (`src/pairing.ts`): 6-digit code generation with 5-min expiry
- **Allowlist** (`src/allowlist.ts`): Device token management (SHA-256 hashed)
- **Identity** (`src/identity.ts`): Persistent instance ID for multi-instance support
- **mDNS** (`src/mdns.ts`): Local network discovery (known issue in subprocess mode)

## Key Files

| File | Purpose |
|------|---------|
| `src/server.ts` | Main entry point, MCP server setup |
| `src/http_bridge.ts` | HTTP/WS bridge for mobile app |
| `src/pairing.ts` | Pairing code logic |
| `src/allowlist.ts` | Device token allowlist |
| `src/identity.ts` | Instance identity management |
| `src/mdns.ts` | mDNS service advertisement |
| `src/notification.ts` | Channel notification helper |
| `src/types.ts` | TypeScript interfaces |

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/instance` | GET | No | Instance identity |
| `/pair/request` | POST | No | Request pairing code |
| `/pair/validate` | POST | No | Validate code, get token |
| `/` | POST | Yes | Send message to Claude Code |
| `/ws` | GET | Yes | WebSocket for replies |

## Environment Variables

- `HITL_CHANNEL_PORT` (default: 8789): Server port
- `HITL_CHANNEL_API_KEY`: Legacy API key (optional)
- `HITL_CHANNEL_NAME`: Display name for instance

## Testing

```bash
bun test                              # All tests
bun test src/__tests__/pairing.test.ts  # Specific test
```

## Known Issues

1. **mDNS in subprocess mode** (#3): `bonjour-service` mDNS fails when running as Claude Code MCP subprocess. Workaround: manual IP:port entry.

## Code Style

- TypeScript with strict mode
- Bun-native APIs (Bun.file, Bun.$, etc.)
- Process.stderr for logging (stdout reserved for MCP)
- Async/await over callbacks

## Related Repos

- [hitl-app](https://github.com/slaser79/hitl-app): Flutter mobile app
- [hitl-shin-relay](https://github.com/slaser79/hitl-shin-relay): Cloud relay service
- [hitl-cli](https://github.com/slaser79/hitl-cli): Python CLI/SDK
