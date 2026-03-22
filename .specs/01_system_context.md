# System Context & Architecture

## Overview

hitl-channel is a TypeScript MCP server that enables **direct bidirectional communication** between the HITL mobile app and Claude Code sessions — with no cloud intermediary. Messages travel directly over LAN or Tailscale network.

## Tech Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Bun | Fast TypeScript runtime |
| Protocol | MCP SDK | Model Context Protocol integration |
| Transport | HTTP + WebSocket | Bidirectional messaging |
| Discovery | bonjour-service | mDNS service advertisement |
| Auth | SHA-256 hash | Device token allowlist |

## Architecture Overview

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
Claude Code (terminal)
```

## Key Components

### 1. MCP Server (`server.ts`)
- Registers `reply_to_hitl` tool for Claude Code to send responses
- Exposes `notifications/claude/channel` experimental capability
- Runs as subprocess spawned by Claude Code

### 2. HTTP Bridge (`http_bridge.ts`)
- REST API for mobile app communication
- WebSocket server for real-time reply streaming
- Handles authentication via device token allowlist

### 3. Pairing System (`pairing.ts`)
- 6-digit numeric codes with 5-minute expiry
- Codes pushed to Claude Code via channel notification
- Device tokens generated on successful validation

### 4. Identity System (`identity.ts`)
- Persistent instance ID (UUID) stored in `~/.hitl/channels/identity.json`
- Display name from `HITL_CHANNEL_NAME` env or hostname
- Multi-instance support via unique identifiers

### 5. Allowlist (`allowlist.ts`)
- Device tokens stored as SHA-256 hashes
- Persistent storage in `~/.hitl/channels/allowlist.json`
- Tracks `addedAt` and `lastUsed` timestamps

### 6. mDNS Discovery (`mdns.ts`)
- Advertises `_hitl-channel._tcp` service on local network
- Enables hitl-app auto-discovery on same network
- **Known Issue**: Does not work in subprocess mode (#3)

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check (status, port, client count) |
| `/instance` | GET | No | Instance identity (instanceId, hostname) |
| `/pair/request` | POST | No | Request pairing code (sent to Claude Code via channel) |
| `/pair/validate` | POST | No | Validate code, returns device token |
| `/` | POST | Yes | Send message to Claude Code |
| `/ws` | GET | Yes | WebSocket for receiving replies |

## Data Storage

All persistent data stored in `~/.hitl/channels/`:

| File | Purpose |
|------|---------|
| `identity.json` | Instance ID (stable across restarts) |
| `allowlist.json` | Paired device token hashes (SHA-256) |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HITL_CHANNEL_PORT` | `8789` | HTTP/WebSocket bridge port |
| `HITL_CHANNEL_API_KEY` | (none) | Legacy API key auth (optional) |
| `HITL_CHANNEL_NAME` | hostname | Display name for the instance |

## Security Model

1. **Pairing Flow**: 6-digit codes with 5-minute expiry prevent unauthorized access
2. **Token Hashing**: Device tokens stored as SHA-256 hashes (not plaintext)
3. **Direct Connection**: No cloud relay — data stays on local network
4. **Optional API Key**: Legacy fallback for backward compatibility

## Integration with HITL Empire

hitl-channel is part of the HITL Empire ecosystem:
- **hitl-app**: Flutter mobile app (iOS/Android) that connects to channels
- **hitl-shin-relay**: Cloud relay service for when direct LAN isn't available
- **hitl-cli**: Python CLI for relay-based HITL (alternative to channel)

## Known Limitations

1. **mDNS in Subprocess**: `bonjour-service` mDNS fails when running as Claude Code MCP subprocess (#3)
2. **Single Port**: All clients share the same WebSocket broadcast
3. **No E2E Encryption**: Relies on network security (LAN/Tailscale)
