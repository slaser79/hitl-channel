---
id: SPEC-HC-001
title: "Secure Pairing System"
status: "Complete"
owner: "hitl-channel"
last_updated: 2026-03-22
---

# Secure Pairing System

## Overview

The pairing system enables HITL mobile app users to securely connect to a hitl-channel instance without pre-shared secrets. It uses a 6-digit numeric code flow similar to Bluetooth pairing.

## User Flow

1. User opens hitl-app and selects "Add Instance"
2. User enters the channel's IP:port (or discovers via mDNS)
3. User taps "Pair" — app calls `POST /pair/request`
4. Server generates 6-digit code, pushes to Claude Code via channel notification
5. Claude Code displays code to user (in terminal output)
6. User enters code in hitl-app
7. App calls `POST /pair/validate` with code
8. Server validates code, generates device token, adds to allowlist
9. App stores token for future authentication

## Technical Design

### Code Generation
- 6 random digits (100000-999999)
- Stored in memory with `createdAt` and `expiresAt` timestamps
- 5-minute expiry (configurable via `CODE_EXPIRY_MS`)

### Code Validation
- Single-use (consumed on successful validation)
- Expired codes automatically rejected
- Invalid codes return 403

### Device Token
- UUID v4 format
- Stored as SHA-256 hash (never plaintext)
- Used for Bearer authentication on protected endpoints

## API Endpoints

### POST /pair/request
No authentication required.

**Response (202 Accepted):**
```json
{
  "status": "pending",
  "message": "Pairing code sent to Claude Code session",
  "expires_in": 300
}
```

### POST /pair/validate
No authentication required.

**Request:**
```json
{
  "code": "123456"
}
```

**Response (200 OK):**
```json
{
  "status": "paired",
  "device_token": "uuid-v4-token",
  "message": "Device successfully paired"
}
```

**Error (403 Forbidden):**
```json
{
  "error": "invalid or expired code"
}
```

## Security Considerations

1. **Code Length**: 6 digits = 1 million combinations, adequate for 5-minute window
2. **Rate Limiting**: Not currently implemented (TODO for production)
3. **Brute Force**: 5-minute expiry limits brute force window
4. **Token Storage**: SHA-256 hashing prevents token extraction from disk

## Files Modified

- `src/pairing.ts`: Core pairing logic
- `src/http_bridge.ts`: HTTP endpoints
- `src/allowlist.ts`: Token storage
- `src/notification.ts`: Channel notification for code delivery

## Acceptance Criteria

- [x] 6-digit codes generated correctly
- [x] Codes expire after 5 minutes
- [x] Valid code returns device token
- [x] Token added to persistent allowlist
- [x] Code pushed to Claude Code via channel notification
- [x] Expired codes rejected with 403
