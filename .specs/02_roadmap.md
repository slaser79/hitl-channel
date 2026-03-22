# Roadmap

## Phase 1: Core MCP Server (COMPLETE)
- [x] Basic MCP server setup with @modelcontextprotocol/sdk
- [x] `reply_to_hitl` tool registration
- [x] Channel notification support (`notifications/claude/channel`)
- [x] HTTP bridge for mobile app communication
- [x] WebSocket server for real-time replies

## Phase 2: Secure Pairing (COMPLETE)
- [x] 6-digit pairing code generation
- [x] 5-minute code expiry
- [x] Pairing code push via channel notification
- [x] Device token generation on successful validation
- [x] SHA-256 token hashing for storage
- [x] Persistent allowlist (`~/.hitl/channels/allowlist.json`)

## Phase 3: Identity & Discovery (PARTIAL)
- [x] Persistent instance identity
- [x] `HITL_CHANNEL_NAME` environment variable
- [x] `/instance` endpoint for identity info
- [x] mDNS service advertisement (`_hitl-channel._tcp`)
- [ ] **Fix mDNS in MCP subprocess mode** (#3)
- [ ] Tailscale peer discovery as fallback

## Phase 4: Attachment Support (COMPLETE)
- [x] Image attachment processing
- [x] Base64 decode and file save
- [x] Attachment path appended to channel notification
- [x] Inbox directory (`~/.claude/channels/hitl-channel/inbox`)

## Phase 5: Multi-Instance Support (IN PROGRESS)
- [x] Unique instance IDs per deployment
- [x] `agent_id` routing in messages
- [ ] Instance selection UI in hitl-app
- [ ] Cross-instance message routing

## Phase 6: Production Hardening (PLANNED)
- [ ] Connection health monitoring
- [ ] Auto-reconnect on WebSocket disconnect
- [ ] Rate limiting for pairing requests
- [ ] Token revocation endpoint
- [ ] Audit logging

## Phase 7: E2E Encryption (PLANNED)
- [ ] ECDH key exchange during pairing
- [ ] Message encryption with derived key
- [ ] Forward secrecy via session keys

## Backlog

### Discovery Improvements
- Alternative discovery via Tailscale API
- QR code pairing (encode IP:port + one-time token)
- Central discovery service for remote access

### Protocol Extensions
- Structured message types (not just text)
- Typing indicators
- Read receipts
- Message threading

### Integration
- hitl-app deep link support
- Claude Code sidebar integration
- Notification history persistence
