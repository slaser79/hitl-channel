# Critic Agent Guide: Verification Tests

## Overview

The Critic agent verifies hitl-channel implementations by running tests and validating protocol behavior. This guide documents how to create and run verification tests.

## Test Architecture

```
src/__tests__/
  allowlist.test.ts      ← Unit tests for token allowlist
  pairing.test.ts        ← Unit tests for pairing code logic
  pairing-integration.test.ts  ← Integration tests for pairing flow
  server.test.ts         ← MCP server integration tests
```

## Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test src/__tests__/pairing.test.ts

# Run with coverage
bun test --coverage
```

## Test Categories

### 1. Unit Tests (Fast, Isolated)

Test individual functions without network or file I/O.

**Example: Pairing Code Generation**
```typescript
import { expect, test } from "bun:test";
import { generatePairingCode, validatePairingCode, createPairingRequest } from "../pairing";

test("generates 6-digit code", () => {
  const code = generatePairingCode();
  expect(code).toMatch(/^\d{6}$/);
});

test("validates active pairing code", () => {
  const code = createPairingRequest();
  expect(validatePairingCode(code)).toBe(true);
});

test("rejects unknown code", () => {
  expect(validatePairingCode("000000")).toBe(false);
});
```

### 2. Integration Tests (Network, Full Flow)

Test HTTP endpoints and WebSocket behavior.

**Example: Pairing Flow**
```typescript
import { expect, test, describe, beforeAll, afterAll } from "bun:test";

describe("pairing integration", () => {
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    // Start test server on random port
    server = startHttpBridge(mockMcp);
  });

  afterAll(() => {
    server.stop();
  });

  test("POST /pair/request returns 202", async () => {
    const res = await fetch(`http://localhost:${server.port}/pair/request`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("pending");
  });

  test("POST /pair/validate with valid code returns token", async () => {
    const code = createPairingRequest();
    const res = await fetch(`http://localhost:${server.port}/pair/validate`, {
      method: "POST",
      body: JSON.stringify({ code }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.device_token).toBeDefined();
  });
});
```

### 3. MCP Protocol Tests

Verify MCP tool registration and channel notifications.

**Example: Tool Registration**
```typescript
import { expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

test("lists reply_to_hitl tool", async () => {
  const tools = await mcp.handleRequest(ListToolsRequestSchema, {});
  expect(tools.tools).toContainEqual(
    expect.objectContaining({ name: "reply_to_hitl" })
  );
});
```

## Verification Checklist

When verifying a feature, the Critic should check:

### Pairing System
- [ ] Code is exactly 6 digits
- [ ] Code expires after 5 minutes
- [ ] Expired code returns 403
- [ ] Valid code returns device token
- [ ] Token is added to allowlist
- [ ] Code can only be used once

### Authentication
- [ ] Protected endpoints require token
- [ ] Invalid token returns 401
- [ ] Legacy API key fallback works
- [ ] Token hash stored (not plaintext)

### WebSocket
- [ ] Client can connect with valid token
- [ ] Replies broadcast to all connected clients
- [ ] Client disconnect cleans up properly

### Channel Notifications
- [ ] Messages reach Claude Code session
- [ ] `sender_id` included in metadata
- [ ] `message_id` generated for threading
- [ ] Attachments processed and saved

### mDNS (when working)
- [ ] Service advertised on network
- [ ] Instance ID in TXT records
- [ ] Display name in service name

## Evidence Collection

For CRITIC reports, capture:

1. **Test Output**: Full `bun test` output
2. **Coverage Report**: If available
3. **Manual Verification**: Screenshots or logs of end-to-end flow
4. **Error Cases**: Verify proper error responses

## Common Issues

### Test Isolation
Tests that modify `~/.hitl/channels/` files should use temp directories:
```typescript
process.env.HITL_CHANNELS_DIR = await mkdtemp(join(tmpdir(), "hitl-test-"));
```

### Port Conflicts
Use random ports for test servers:
```typescript
const server = Bun.serve({ port: 0 }); // Random available port
const port = server.port;
```

### Async Cleanup
Always clean up servers and file handles:
```typescript
afterAll(() => {
  server.stop();
  // Clean up temp files
});
```
