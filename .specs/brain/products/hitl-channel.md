---
title: "hitl-channel"
type: product
products: [hitl-channel]
last_updated: 2026-04-14
sources:
  - config/empire.yaml
cross_refs:
  - ../index.md
  - ../entities/jules-remote-vm.md
---

# hitl-channel (Claude Code MCP Plugin)

Claude Code MCP (Model Context Protocol) plugin providing HitL capabilities directly within AI development tools.

## Architecture Overview

A specialized bridge between the Claude Code ecosystem and the HitL platform. It allows Claude to interact with human-in-the-loop tasks, fetch context, and request approvals through the MCP standard.

### Core Components

- **MCP Server**: Implements the Model Context Protocol for seamless integration with Claude Code.
- **HitL Integration**: Connects to the HitL API to fetch and respond to pending requests.
- **Workflow Tools**: Exposed tools for Claude to initiate and monitor HitL tasks.

## Tech Stack

- **Language**: TypeScript/Node.js
- **Protocol**: Model Context Protocol (MCP)
- **Deployment**: Local plugin for Claude Code.

## Key Patterns

- **Context Compression**: Intelligently summarize HitL state to fit within Claude's context window.
- **Real-time Notifications**: Notify the user immediately when an agent requires input.
- **Approval Flow**: Streamlined mechanism for approving or rejecting agent actions within the CLI.

## Known Gotchas

- **MCP Protocol Updates**: The MCP standard is evolving; keep the plugin updated with latest protocol versions.
- **Latency**: Network latency in fetching HitL requests can impact Claude's response time.
- **Context Limits**: Large HitL request bodies can exhaust context limits; use targeted extraction where possible.
