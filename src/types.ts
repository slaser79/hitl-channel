export interface HitlAttachment {
  type: string;
  media_type: string;
  data: string;
  fileName?: string;
}

export interface HitlMessage {
  message?: string;
  content?: string;
  sender_id?: string;
  agent_id?: string;
  attachments?: HitlAttachment[];
}

export interface ChannelMeta {
  message_id: string;
  ts: string;
  sender_id: string;
  agent_id?: string;
  [key: string]: string | undefined;
}

export interface ReplyPayload {
  type: "reply";
  text: string;
  content: string;
  id: string;
  message_id?: string;
  agent_id?: string;
  ts: string;
}

export interface HitlWebSocket {
  readyState: number;
  send: (data: string) => number | void;
}

// ─── SPEC-HITL-CC-001 frame types ──────────────────────────────────────────
// New WS frame types added by Phase 1 of the Companion Agent spec. All frames
// are JSON text frames on the existing `/ws` endpoint and co-exist with the
// pre-existing `reply` / `choices` shapes.

export interface ToolCallRequestFrame {
  type: "tool_call_request";
  request_id: string;
  name: string;
  arguments: Record<string, unknown>;
  timeout_seconds: number;
  cc_instance_id: string;
}

export interface ToolCallResultFrame {
  type: "tool_call_result";
  request_id: string;
  success: boolean;
  output?: unknown;
  error?: string | null;
  approval?: "auto" | "user_approved" | "user_denied" | "timeout";
}

export interface ListToolsRequestFrame {
  type: "list_tools_request";
  request_id: string;
  filter?: string;
}

export interface ListedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  tier: string; // free | softConfirm | hardConfirm
}

export interface ListToolsResultFrame {
  type: "list_tools_result";
  request_id: string;
  tools: ListedTool[];
}

export interface BootstrapFrame {
  type: "bootstrap";
  content: string;
  meta: { type: "bootstrap" };
}

// ─── SPEC-HITL-CC-001 Phase 4 AC#26 — ReplyBuffer types ───────────────────
// Per-instance in-memory ring buffer for replies that arrive while no WS
// clients are connected. Entries drain in arrival order on WS reconnect.

export interface BufferedReply {
  /** The reply frame to replay on drain. */
  payload: ReplyPayload;
  /**
   * Pre-stringified `payload` cached at push time. Sent verbatim during
   * drain so we don't re-serialize on every reconnect.
   */
  raw: string;
  /** Wall-clock ms epoch when push() was called. Used for TTL + drain age. */
  queuedAt: number;
}
