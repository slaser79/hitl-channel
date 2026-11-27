// SPEC-HITL-CC-001 — MCP `serverInfo.instructions` payload.
//
// This module exposes the composed string CC observes on MCP `initialize`,
// split into named blocks so the AC#23a snapshot test (and any future
// doc-shape audit) can pin individual contracts without parsing the
// composed blob.
//
// Kept SEPARATE from `server.ts` because that module performs top-level
// `await mcp.connect(...)` + `startHttpBridge(mcp)` on import — bun would
// EADDRINUSE inside a test that just wants to inspect the strings.

// Phase 1 — production tool bridge standing orders (PR slaser79/hitl-channel#8).
// Split per SPEC-HC-005 §4.2 item 5 into the shared phone-tool core and the
// mode-specific reply instructions, while keeping STANDING_ORDERS and
// MCP_INSTRUCTIONS byte-identical for channel mode.
export const PHONE_TOOL_STANDING_ORDERS = [
  "Treat inbound channel notifications as user queries from the paired HITL phone.",
  "For phone-relevant questions or actions (calendar, contacts, agents, navigation, send/compose, file ops, …),",
  "default to `call_phone_tool(name, arguments)` — see `list_phone_tools()` for the live catalog.",
  "Trust-tier confirms are gated on the phone UI; you do not need to ask the user for yes/no in chat —",
  "the user will tap Approve or Deny on a system sheet and the call returns with `approval:` populated.",
].join(" ");

export const STANDING_ORDERS = [
  PHONE_TOOL_STANDING_ORDERS,
  "When you do speak back to the user, use `reply_to_hitl` with the inbound `message_id`.",
  "Requires Claude Code v2.1.80+ for `--dangerously-load-development-channels`.",
].join(" ");

// SPEC-HC-005 §4.2 item 5 — daemon-mode standing orders appended to the
// ACP harness system prompt. Your turn's final text is delivered to the phone
// automatically, and human-in-the-loop relay tools must not be called here.
export const DAEMON_REPLY_ORDERS = [
  "Your turn's final text output is delivered to the HITL phone automatically, so do not repeat it through `reply_to_hitl`.",
  "Use `reply_to_hitl` only for interim progress updates or to send inline image/file attachments.",
  "When you receive a `<workflow_delegation message_id=X>…</workflow_delegation>` envelope, finish all work FIRST, then end your turn with the final answer.",
  "Do not use `human-in-the-loop` or cloud relay tools to talk to this user, because this chat is already the channel.",
].join(" ");

export const DAEMON_PEER_ORCHESTRATION_ORDERS = [
  "To collaborate with phone agents, use the five typed peer tools instead of `call_phone_tool('dispatch_agent' | 'message_agent')`:",
  "`list_phone_agents` discovers available phone specialists;",
  "`run_phone_agent` runs a phone specialist synchronously;",
  "`dispatch_phone_agent` starts an async phone run (completions wake your session automatically);",
  "`message_phone_agent` sends a mid-run message to `to: 'parent'` or a sibling `run_id`;",
  "`get_phone_run` inspects a dispatched run's status and output.",
].join(" ");

export const DAEMON_INSTRUCTIONS = [
  PHONE_TOOL_STANDING_ORDERS,
  DAEMON_REPLY_ORDERS,
  DAEMON_PEER_ORCHESTRATION_ORDERS,
].join(" ");

// Phase 3 (issue slaser79/hitl-app#4010) — final-reply ceremony for
// workflow delegations. When a paired phone's workflow runner delegates
// to CC via `ClaudeCodeAgentRunner`, the prompt arrives wrapped in a
// `<workflow_delegation message_id=X>…</workflow_delegation>` envelope;
// the runner waits for the FIRST `reply_to_hitl(message_id=X)` and treats
// it as the workflow step's output. Intermediate replies on the same X
// drop through the runner's filter into chat-history persistence. The
// contract is normative for CC, so the wording is appended to the MCP
// `instructions` field rather than left implicit.
export const WORKFLOW_DELEGATION_CEREMONY = [
  "When you receive an inbound channel notification whose content is wrapped in",
  "`<workflow_delegation message_id=X>…</workflow_delegation>` tags,",
  "do all your work FIRST, then call `reply_to_hitl(message_id=X, content=<your final answer>)`",
  "EXACTLY ONCE. Intermediate calls to `reply_to_hitl(message_id=X, …)` for the same X are",
  "dropped by the waiter — only the first matching reply resolves. If you need to chat",
  "informally during the delegation (e.g. confirm receipt), use a different message_id or",
  "omit message_id; only the message_id matching the delegation envelope counts as the",
  "final answer.",
].join(" ");

// Composed instructions block — the exact string CC observes on
// MCP `initialize`. Pinned by `src/__tests__/server-instructions.test.ts`.
export const MCP_INSTRUCTIONS = [
  'Messages from the HITL mobile app arrive as <channel source="hitl-channel" sender_id="..." message_id="...">.',
  "Use the reply_to_hitl tool to send responses back to the mobile app user.",
  "The sender_id indicates who sent the message (e.g., 'ceo', 'xo').",
  STANDING_ORDERS,
  WORKFLOW_DELEGATION_CEREMONY,
].join(" ");
