---
id: SPEC-HC-002
title: "mDNS Service Discovery"
status: "Blocked"
owner: "hitl-channel"
last_updated: 2026-03-22
blocked_by: "#3 - mDNS not working in subprocess mode"
---

# mDNS Service Discovery

## Overview

mDNS (Multicast DNS) enables the HITL mobile app to automatically discover hitl-channel instances on the local network without manual IP:port entry.

## Service Definition

| Property | Value |
|----------|-------|
| Service Type | `_hitl-channel._tcp` |
| Port | Dynamic (default 8789) |
| TXT Records | `version`, `instanceId`, `displayName` |

## Implementation

Uses `bonjour-service` package for cross-platform mDNS:

```typescript
const bonjour = new Bonjour();
bonjour.publish({
  name: `${displayName}-${instanceId.slice(0, 8)}`,
  type: "_hitl-channel._tcp",
  port: 8789,
  txt: {
    version: "0.0.1",
    instanceId: "uuid",
    displayName: "My Workstation",
  },
});
```

## Known Issue (#3)

**mDNS does not work when hitl-channel runs as a Claude Code MCP subprocess.**

### Symptoms
- `dns-sd -B _hitl-channel._tcp` returns no results
- No error logged (silent failure)
- Works fine when run standalone (`bun src/server.ts`)

### Root Cause (Investigation Needed)
1. **Multicast UDP**: MCP subprocesses may not have multicast socket access
2. **macOS Firewall**: Unsigned subprocess binaries blocked from multicast
3. **Network Interface**: Subprocess may not see correct network interface
4. **stdio Capture**: stderr capture may interfere with bonjour internals

### Workarounds
1. **Manual Entry**: User enters IP:port manually
2. **Tailscale**: Use Tailscale hostname (always reachable)
3. **Standalone Process**: Run hitl-channel outside Claude Code (defeats purpose)

## Proposed Fixes

### Option A: Separate mDNS Process
Run mDNS advertisement in a detached process:
```typescript
spawn("bun", ["src/mdns-daemon.ts"], { detached: true, stdio: "ignore" });
```

### Option B: Tailscale API Discovery
Query Tailscale API for devices running hitl-channel:
```typescript
const devices = await fetch("https://api.tailscale.com/api/v2/tailnet/-/devices");
```

### Option C: Central Discovery Service
Register with a lightweight discovery service:
```typescript
await fetch("https://discovery.hitlrelay.app/register", {
  method: "POST",
  body: JSON.stringify({ instanceId, ip, port }),
});
```

## Mobile App Integration

When working, hitl-app will:
1. Browse for `_hitl-channel._tcp` services
2. Display discovered instances with display name
3. Allow tap-to-connect (pre-fills IP:port)

## Files

- `src/mdns.ts`: mDNS advertisement logic
- `src/server.ts`: Calls `startMDNS()` on startup

## Acceptance Criteria

- [ ] Service discoverable via `dns-sd -B _hitl-channel._tcp`
- [ ] TXT records include instanceId and displayName
- [ ] Works in MCP subprocess mode
- [ ] hitl-app discovers and displays instances
