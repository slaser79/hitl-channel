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
  metadata?: Record<string, any>;
  type?: string;
  batch_id?: string;
  batch_answer?: Record<string, any>;
  cancelled?: boolean;
  id?: string;
  choices_id?: string;
  option_id?: string;
  selections?: string[];
  timestamp?: string;
}

export interface ChannelMeta {
  message_id: string;
  ts: string;
  sender_id: string;
  agent_id?: string;
  [key: string]: any;
}

export interface ReplyPayload {
  type: "reply";
  text: string;
  content: string;
  id: string;
  message_id?: string;
  agent_id?: string;
  acpSessionId?: string;
  ts: string;
  attachments?: HitlAttachment[];
  turnId?: string;
  isTurnFinal?: boolean;
  toolSteps?: ToolStepSummary[];
}

export interface HitlWebSocketData {
  tokenHash?: string;
  connectedAt?: string;
  lastSeen?: string;
  proto?: number;
  features?: Set<string>;
  [key: string]: unknown;
}

export interface HitlWebSocket {
  data?: HitlWebSocketData;
  readyState: number;
  send: (data: string) => number | void;
}

// ─── SPEC-HITL-CC-001 frame types ──────────────────────────────────────────
// New WS frame types added by Phase 1 of the Companion Agent spec. All frames
// are JSON text frames on the existing `/ws` endpoint and co-exist with the
// pre-existing `reply` / `choices` shapes.

export interface InstanceCapabilities {
  sessions: boolean;
  streaming: boolean;
  choicesId: boolean;
  models?: boolean;
  commands?: boolean;
  peerOrchestration?: boolean;
  concurrentSessions?: boolean;
}

export interface ToolCallOrigin {
  acp_session_id: string | null;
  run_id?: string | null;
  parent_run_id?: string | null;
  episode_root_run_id?: string | null;
  dispatch_depth?: number;
  message_hop?: number;
  mode: "daemon" | "channel";
}

export interface ToolCallRequestFrame {
  type: "tool_call_request";
  request_id: string;
  name: string;
  arguments: Record<string, unknown>;
  timeout_seconds: number;
  cc_instance_id: string;
  origin?: ToolCallOrigin;
}

export interface ToolCallResultFrame {
  type: "tool_call_result";
  request_id: string;
  success: boolean;
  output?: unknown;
  data?: unknown;
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

// ─── SPEC-HC-004 — Batched-question frame types ───────────────────────────
// Mirror of the relay-side SPEC-AW-311 shapes so a payload captured on either
// transport is structurally identical. `allow_other` is accepted in the type
// definition but has no MV-time semantics on the channel side (Phase 2 deferred).

export interface QuestionSpec {
  header: string;
  question: string;
  choices: string[];
  multi_select?: boolean;
  allow_other?: boolean;
}

export interface QuestionAnswer {
  header: string;
  selected: string[];
  other_text?: string;
}

export interface QuestionsBatchRequestFrame {
  type: "questions_batch_request";
  request_id: string;
  questions: QuestionSpec[];
  acpSessionId?: string;
  ts: string;
}

export interface QuestionsBatchResultFrame {
  type: "questions_batch_result";
  request_id: string;
  answers: QuestionAnswer[];
  cancelled: boolean;
}

// ─── SPEC-HITL-APP-10827 Milestone 3a (SPEC-HC-005 Phase 3a) frame types ──
// Capability-negotiated session sync, control RPCs, and choice settlement
// frames. Sent ONLY to sockets declaring matching features via client_hello.

export interface ClientHelloFrame {
  type: "client_hello";
  proto: number;
  features: string[];
}

export interface SessionListRequestFrame {
  type: "session_list_request";
  requestId?: string;
}

export interface SessionNewFrame {
  type: "session_new";
  cwd?: string;
  requestId?: string;
}

export interface SessionResumeFrame {
  type: "session_resume";
  sessionId: string;
  cwd?: string;
  includeRecentTurns?: boolean;
  requestId?: string;
}

export interface SessionListEntry {
  sessionId: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
}

export interface SessionListFrame {
  type: "session_list";
  sessions: SessionListEntry[];
  activeSessionId: string | null;
  defaultCwd: string;
  recentCwds: string[];
  requestId?: string;
}

export interface RecentTurnSummary {
  role: "user" | "assistant";
  text: string;
}

export interface SessionSwitchedFrame {
  type: "session_switched";
  sessionId: string | null;
  title?: string | null;
  cwd?: string | null;
  recentTurns?: RecentTurnSummary[];
  requestId?: string;
}

export type SessionErrorAction =
  | "session_new"
  | "session_resume"
  | "session_list_request"
  | "session_set_model";

export type SessionErrorCode =
  | "turn_busy"
  | "invalid_cwd"
  | "load_timeout"
  | "load_failed"
  | "invalid_model";

export interface SessionErrorFrame {
  type: "session_error";
  action: SessionErrorAction;
  code: SessionErrorCode;
  message: string;
  requestId?: string;
}

// ─── SPEC-HITL-APP-10831 Phase 2 frame types ───────────────────────────────
// Capability-negotiated model visibility/switching ("models") and host slash
// command discovery ("commands"). Sent ONLY to sockets declaring matching
// features via client_hello.

export interface AcpModelInfo {
  modelId: string;
  name: string;
  description?: string | null;
  [key: string]: unknown;
}

export interface ChannelModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

export interface ModelsStateFrame {
  type: "models_state";
  sessionId: string | null;
  currentModelId: string | null;
  availableModels: ChannelModelInfo[];
  requestId?: string;
}

export interface SessionSetModelFrame {
  type: "session_set_model";
  sessionId?: string;
  modelId: string;
  requestId?: string;
}

export type ChannelSlashCommandSource = "host" | "daemon";

export interface ChannelSlashCommand {
  name: string;
  description?: string;
  inputHint?: string;
  source: ChannelSlashCommandSource;
}

export interface CommandsListFrame {
  type: "commands_list";
  sessionId: string | null;
  commands: ChannelSlashCommand[];
}

export interface ChoicesSettledFrame {
  type: "choices_settled";
  frameIds: string[];
  acpSessionId?: string | null;
  reason: "cancelled" | "answered";
  selectedLabel?: string;
}

// ─── SPEC-HITL-APP-10827 Milestone 3b (SPEC-HC-005 Phase 3b) frame types ──
// Live streaming deltas, tool progress, turn state, and turn cancellation
// frames. Ephemeral control/stream frames go ONLY to sockets declaring
// `"streaming"` via `client_hello`.

export type ToolStepStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolStepSummary {
  toolCallId: string;
  name: string;
  title: string;
  kind?: string;
  status: ToolStepStatus;
  summary?: string;
}

export interface CancelTurnFrame {
  type: "cancel_turn";
  sessionId?: string;
  requestId?: string;
}

export interface StreamDeltaFrame {
  type: "stream_delta";
  sessionId: string;
  turnId: string;
  seq: number;
  delta: string;
  reset?: boolean;
  truncated?: boolean;
}

export interface ToolProgressFrame {
  type: "tool_progress";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  name: string;
  title: string;
  kind?: string;
  status: ToolStepStatus;
  summary?: string;
}

export type TurnStateValue = "idle" | "running" | "waiting_approval";

export interface TurnStateFrame {
  type: "turn_state";
  sessionId: string | null;
  turnId?: string;
  state: TurnStateValue;
  queueDepth: number;
  finalReplyId?: string | null;
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

// ─── SPEC-HITL-APP-10832 Phase 1a — Two-Way Peer Orchestration frames ─────

export interface HostRunStartFrame {
  type: "host_run_start";
  run_id: string;
  prompt: string;
  cwd?: string;
  acp_session_id?: string;
  external_session_key?: string;
  parent_run_id?: string | null;
  episode_root_run_id?: string | null;
  dispatch_depth: number;
  message_hop: number;
  request_id?: string;
}

export interface HostRunMessageFrame {
  type: "host_run_message";
  run_id: string;
  acp_session_id?: string;
  event_id: string;
  kind: "agent_message" | "permission_response";
  text?: string;
  sender_agent_id?: string;
  sender_name?: string;
  message_hop?: number;
  choices_id?: string;
  option_id?: string;
}

export interface HostRunCancelFrame {
  type: "host_run_cancel";
  run_id: string;
  acp_session_id?: string;
  reason?: string;
}

export interface HostRunAckFrame {
  type: "host_run_ack";
  event_id?: string;
  run_id?: string;
  acp_session_id?: string;
}

export interface PhoneRunWakeFrame {
  type: "phone_run_wake";
  event_id: string;
  run_id: string;
  acp_session_id: string;
  status: "completed" | "failed" | "paused" | "agent_message";
  output?: string;
  error?: string;
  sender_agent_id?: string;
  sender_name?: string;
  message_hop?: number;
}

export type HostRunEventKind =
  | "started"
  | "agent_message"
  | "permission_request"
  | "completed"
  | "failed"
  | "cancelled"
  | "outbox_compacted";

export interface HostRunEventOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface HostRunEventFrame {
  type: "host_run_event";
  event_id: string;
  run_id: string;
  acp_session_id: string;
  kind: HostRunEventKind;
  pinned?: boolean;
  text?: string;
  output?: string;
  output_truncated?: boolean;
  original_bytes?: number;
  error?: string;
  reason?: string;
  dropped_count?: number;
  choices_id?: string;
  tool_name?: string;
  prompt?: string;
  options?: HostRunEventOption[];
  ts: string;
}

export interface WorkerSessionContext {
  runId: string;
  acpSessionId: string;
  parentRunId: string | null;
  episodeRootRunId: string | null;
  dispatchDepth: number;
  messageHop: number;
  externalSessionKey?: string;
  cwd: string;
}
