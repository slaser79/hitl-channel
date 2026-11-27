import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AcpClient,
  AcpRpcError,
  spawnAcpTransport,
  type AcpAgentCapabilities,
  type AcpAvailableCommand,
  type AcpConfigOption,
  type AcpContentBlock,
  type AcpMcpServer,
  type AcpPermissionOption,
  type AcpPermissionRequestParams,
  type AcpPermissionToolCall,
  type AcpSessionInfo,
  type AcpSessionModels,
  type AcpSessionUpdateParams,
  type AcpSystemPrompt,
  type AcpTransport,
} from "./acp_client.js";
import { appendAudit, sha256Hex, stableStringify } from "./audit.js";
import {
  broadcastReply,
  broadcastToCapable,
  processAttachments,
  sendControlToClient,
  unicastFrame,
  type BroadcastReplyOptions,
  type InboundHandlers,
  type InboundMessage,
} from "./http_bridge.js";
import { DAEMON_INSTRUCTIONS } from "./mcp_instructions.js";
import { WorkerOutbox } from "./reply_buffer.js";
import type {
  ChannelModelInfo,
  ChannelSlashCommand,
  ChoicesSettledFrame,
  CommandsListFrame,
  HitlAttachment,
  HitlWebSocket,
  HostRunAckFrame,
  HostRunCancelFrame,
  HostRunEventFrame,
  HostRunMessageFrame,
  HostRunStartFrame,
  ModelsStateFrame,
  PhoneRunWakeFrame,
  RecentTurnSummary,
  SessionErrorFrame,
  SessionListEntry,
  SessionListFrame,
  SessionSwitchedFrame,
  StreamDeltaFrame,
  ToolProgressFrame,
  ToolStepStatus,
  ToolStepSummary,
  TurnStateFrame,
  TurnStateValue,
  WorkerSessionContext,
} from "./types.js";

export type McpTransportMode = "auto" | "http" | "stdio";
export type SystemPromptStrategy =
  | "agy_meta"
  | "acp_system_prompt"
  | "first_prompt_prefix";

export interface HarnessDefinition {
  name: string;
  command: string;
  args: string[];
  fallbackCommand?: string;
  fallbackArgs?: string[];
  commandEnvVar?: string;
  defaultPort: number;
  defaultMcpTransport: "http" | "stdio";
  mcpServerName: string;
  autoAllowPrefixes: string[];
  matchBareTitlePrefix: boolean;
  concurrentSessions: boolean;
  systemPromptStrategy: SystemPromptStrategy;
  buildSystemPromptMeta?: (instructions: string) => Record<string, unknown>;
}

export const HARNESS_REGISTRY: Record<string, HarnessDefinition> = {
  agy: {
    name: "agy",
    command: "agy",
    args: ["acp"],
    commandEnvVar: "HITL_AGY_BIN",
    defaultPort: 8790,
    defaultMcpTransport: "http",
    mcpServerName: "hitl-channel",
    autoAllowPrefixes: ["mcp_hitl-channel_"],
    matchBareTitlePrefix: false,
    concurrentSessions: true,
    systemPromptStrategy: "agy_meta",
    buildSystemPromptMeta(instructions: string) {
      return {
        antigravity: {
          systemPrompt: {
            append: instructions,
          },
        },
      };
    },
  },
  codex: {
    name: "codex",
    command: "codex-acp",
    args: [],
    fallbackCommand: "npx",
    fallbackArgs: ["-y", "@agentclientprotocol/codex-acp"],
    commandEnvVar: "HITL_CODEX_ACP_BIN",
    defaultPort: 8791,
    defaultMcpTransport: "http",
    mcpServerName: "hitl-channel",
    autoAllowPrefixes: ["mcp.hitl-channel."],
    matchBareTitlePrefix: true,
    concurrentSessions: true,
    systemPromptStrategy: "acp_system_prompt",
  },
  hermes: {
    name: "hermes",
    command: "hermes",
    args: ["acp"],
    commandEnvVar: "HITL_HERMES_BIN",
    defaultPort: 8792,
    defaultMcpTransport: "http",
    mcpServerName: "hitl-channel",
    autoAllowPrefixes: ["mcp__hitl_channel__"],
    matchBareTitlePrefix: true,
    concurrentSessions: false,
    systemPromptStrategy: "first_prompt_prefix",
  },
};

export function resolveHarnessLaunch(
  def: HarnessDefinition,
  env: NodeJS.ProcessEnv = process.env,
  whichFn: (cmd: string) => string | null = (cmd) => Bun.which(cmd),
): { command: string; args: string[] } {
  if (def.commandEnvVar) {
    const override = env[def.commandEnvVar]?.trim();
    if (override) {
      return { command: override, args: [...def.args] };
    }
  }
  if (!def.fallbackCommand || whichFn(def.command)) {
    return { command: def.command, args: [...def.args] };
  }
  return {
    command: def.fallbackCommand,
    args: [...(def.fallbackArgs ?? def.args)],
  };
}

function hasCommandField(rawInput: unknown): boolean {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return false;
  }
  return typeof (rawInput as Record<string, unknown>).command === "string";
}

function evaluateOwnHitlCandidate(
  candidate: AcpPermissionToolCall,
  autoAllowPrefixes: string[],
  matchBareTitlePrefix: boolean,
  extraRawInput?: unknown,
): { decided: boolean; allowed: boolean } {
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";

  if (name.length > 0) {
    return {
      decided: true,
      allowed: autoAllowPrefixes.some((prefix) => name.startsWith(prefix)),
    };
  }
  if (title.length > 0) {
    const matchesRunPrefix = autoAllowPrefixes.some((prefix) =>
      title.startsWith(`Run ${prefix}`),
    );
    const matchesBarePrefix =
      matchBareTitlePrefix &&
      autoAllowPrefixes.some((prefix) => title.startsWith(prefix));
    const isShellCommand =
      hasCommandField(candidate.rawInput) || hasCommandField(extraRawInput);
    return {
      decided: true,
      allowed: (matchesRunPrefix || matchesBarePrefix) && !isShellCommand,
    };
  }
  return { decided: false, allowed: false };
}

/**
 * Fail-closed check for whether a `session/request_permission` belongs to the
 * daemon's own injected HITL MCP tools (which the phone already gates with its
 * trust-tier sheets).
 */
export function isOwnHitlTool(
  toolCall: AcpPermissionToolCall,
  autoAllowPrefixes: string[],
  opts?: {
    matchBareTitlePrefix?: boolean;
    correlatedToolCall?: AcpPermissionToolCall;
  },
): boolean {
  const matchBare = opts?.matchBareTitlePrefix ?? false;
  const direct = evaluateOwnHitlCandidate(
    toolCall,
    autoAllowPrefixes,
    matchBare,
    opts?.correlatedToolCall?.rawInput,
  );
  if (direct.decided) {
    return direct.allowed;
  }
  if (opts?.correlatedToolCall) {
    const correlated = evaluateOwnHitlCandidate(
      opts.correlatedToolCall,
      autoAllowPrefixes,
      matchBare,
      toolCall.rawInput,
    );
    if (correlated.decided) {
      return correlated.allowed;
    }
  }
  return false;
}

export function extractWorkflowDelegationMessageId(text: string): string | null {
  const match = text.match(
    /<workflow_delegation\b[^>]*\bmessage_id\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i,
  );
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * Returns true when an ACP RPC error definitively indicates a missing session or
 * trajectory (as opposed to an unsupported RPC/method error that should fall
 * back to `session/resume`).
 */
export function isSessionNotFoundError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("method not found")) {
    return false;
  }
  return (
    msg.includes("not_found") ||
    msg.includes("not found") ||
    msg.includes("does not exist") ||
    msg.includes("enoent")
  );
}

function deriveToolName(
  toolCall: AcpPermissionToolCall,
  correlated?: AcpPermissionToolCall,
): string {
  const name = typeof toolCall.name === "string" ? toolCall.name.trim() : "";
  if (name.length > 0) return name;
  const title = typeof toolCall.title === "string" ? toolCall.title.trim() : "";
  if (title.length > 0) {
    return title.startsWith("Run ") ? title.slice(4).trim() : title;
  }
  if (correlated) {
    const corrName = typeof correlated.name === "string" ? correlated.name.trim() : "";
    if (corrName.length > 0) return corrName;
    const corrTitle =
      typeof correlated.title === "string" ? correlated.title.trim() : "";
    if (corrTitle.length > 0) {
      return corrTitle.startsWith("Run ") ? corrTitle.slice(4).trim() : corrTitle;
    }
  }
  if (typeof toolCall.kind === "string" && toolCall.kind.trim().length > 0) {
    return toolCall.kind.trim();
  }
  return "unknown_tool";
}

function oneLineSummary(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  try {
    return JSON.stringify(value).replace(/\s+/g, " ").trim();
  } catch {
    return String(value).replace(/\s+/g, " ").trim();
  }
}

function formatPermissionPrompt(
  toolCall: AcpPermissionToolCall,
  correlated?: AcpPermissionToolCall,
): string {
  const ownTitle = typeof toolCall.title === "string" ? toolCall.title.trim() : "";
  const corrTitle =
    correlated && typeof correlated.title === "string"
      ? correlated.title.trim()
      : "";
  const title = ownTitle || corrTitle || deriveToolName(toolCall, correlated);
  const rawInput =
    toolCall.rawInput !== undefined ? toolCall.rawInput : correlated?.rawInput;
  const inputSummary = oneLineSummary(rawInput);
  const raw = inputSummary ? `${title}: ${inputSummary}` : title;
  return raw.length > 300 ? `${raw.slice(0, 297)}...` : raw;
}

function formatRelativeTime(isoOrDate: string | undefined, nowMs: number): string {
  if (!isoOrDate) return "unknown";
  const ts = Date.parse(isoOrDate);
  if (!Number.isFinite(ts)) return "unknown";
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function expandHomeAndResolve(rawPath: string, baseDir: string): string {
  const home = process.env.HOME?.trim() || homedir();
  if (rawPath === "~") {
    return home;
  }
  if (rawPath.startsWith("~/")) {
    return resolvePath(join(home, rawPath.slice(2)));
  }
  return resolvePath(baseDir, rawPath);
}

const MAX_RECENT_TURNS = 6;
const MAX_RECENT_TURN_CHARS = 1200;
const MAX_RECENT_TURNS_BYTES = 8 * 1024;
const MAX_SESSION_LIST_SIZE = 50;
const MAX_RECENT_CWDS = 8;
const DEFAULT_SESSION_LOAD_TIMEOUT_MS = 10_000;
const DEFAULT_STREAM_COALESCE_MS = 75;
const MAX_STREAM_DELTA_FRAME_BYTES = 16 * 1024;
const MAX_TURN_DELTA_BYTES = 256 * 1024;
const MAX_RECONNECT_SNAPSHOT_BYTES = 128 * 1024;
const MAX_TOOL_STEPS = 32;
const MAX_EPHEMERAL_TOOL_SUMMARY_CHARS = 512;
const MAX_DURABLE_TOOL_SUMMARY_CHARS = 256;
const MAX_MODELS_COUNT = 100;
const MAX_MODEL_ID_CHARS = 128;
const MAX_MODEL_NAME_CHARS = 128;
const MAX_MODEL_DESC_CHARS = 200;
const MAX_COMMANDS_COUNT = 200;
const MAX_CMD_NAME_CHARS = 64;
const MAX_CMD_DESC_CHARS = 200;
const MAX_CMD_HINT_CHARS = 80;

const DAEMON_SLASH_COMMANDS: ReadonlyArray<ChannelSlashCommand> = [
  {
    name: "help",
    description: "Show available daemon commands",
    source: "daemon",
  },
  {
    name: "new",
    description: "Start a new session",
    inputHint: "[harness] [cwd]",
    source: "daemon",
  },
  {
    name: "sessions",
    description: "List recent sessions",
    source: "daemon",
  },
  {
    name: "resume",
    description: "Switch to and resume a session",
    inputHint: "<n|id>",
    source: "daemon",
  },
  {
    name: "cancel",
    description: "Cancel pending approvals and stop the running turn",
    source: "daemon",
  },
  {
    name: "status",
    description: "Show harness, active session, turn, queue, and approvals",
    source: "daemon",
  },
];

const RESERVED_DAEMON_COMMAND_NAMES = new Set(
  DAEMON_SLASH_COMMANDS.map((cmd) => cmd.name),
);

type ModelSelectionMethod = "set_model" | "set_config_option";

interface SessionModelState {
  selectionMethod: ModelSelectionMethod;
  configOptionId?: string;
  currentModelId: string | null;
  allAvailableModels: ChannelModelInfo[];
  availableModels: ChannelModelInfo[];
  knownModelIds: Set<string>;
}

interface ReplayCaptureBuffer {
  turns: RecentTurnSummary[];
  title?: string;
  detached: boolean;
}

function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end--;
  }
  return text.slice(0, end);
}

function normalizeModelId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_MODEL_ID_CHARS) return null;
  return trimmed;
}

function normalizeModelEntries(
  rawList: unknown,
  extract: (entry: Record<string, unknown>) => {
    rawId: unknown;
    rawName: unknown;
    rawDesc: unknown;
  },
): ChannelModelInfo[] {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set<string>();
  const out: ChannelModelInfo[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const { rawId, rawName, rawDesc } = extract(item as Record<string, unknown>);
    if (typeof rawId !== "string") continue;
    const trimmedId = rawId.trim();
    if (!trimmedId) continue;
    // Preserve exact ACP modelId for session_set_model matching; skip over-limit IDs
    // rather than truncating into an unselectable identifier.
    if (trimmedId.length > MAX_MODEL_ID_CHARS) continue;
    const modelId = trimmedId;
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    const nameStr =
      typeof rawName === "string" && rawName.trim().length > 0
        ? rawName.trim()
        : modelId;
    const name = truncateChars(nameStr, MAX_MODEL_NAME_CHARS);
    const description =
      typeof rawDesc === "string" && rawDesc.trim().length > 0
        ? truncateChars(rawDesc.trim(), MAX_MODEL_DESC_CHARS)
        : undefined;
    out.push({
      modelId,
      name,
      ...(description !== undefined ? { description } : {}),
    });
  }
  return out;
}

function normalizeChannelModels(rawList: unknown[]): ChannelModelInfo[] {
  return normalizeModelEntries(rawList, (entry) => ({
    rawId: entry.modelId,
    rawName: entry.name,
    rawDesc: entry.description,
  }));
}

function normalizeConfigOptionModels(
  options: AcpConfigOption["options"],
): ChannelModelInfo[] {
  return normalizeModelEntries(options, (entry) => ({
    rawId: entry.value,
    rawName: entry.name,
    rawDesc: entry.description,
  }));
}

function capAvailableModels(
  allModels: ChannelModelInfo[],
  currentModelId: string | null,
): ChannelModelInfo[] {
  const capped = allModels.slice(0, MAX_MODELS_COUNT);
  if (
    currentModelId &&
    capped.length === MAX_MODELS_COUNT &&
    !capped.some((m) => m.modelId === currentModelId)
  ) {
    const currentEntry = allModels.find((m) => m.modelId === currentModelId);
    if (currentEntry) {
      capped[MAX_MODELS_COUNT - 1] = currentEntry;
    }
  }
  return capped;
}

function findModelConfigOption(
  configOptions: AcpConfigOption[],
): AcpConfigOption | undefined {
  return (
    configOptions.find(
      (opt) => opt && typeof opt === "object" && opt.category === "model",
    ) ??
    configOptions.find(
      (opt) => opt && typeof opt === "object" && opt.id === "model",
    )
  );
}

function findTierConfigOption(
  configOptions: AcpConfigOption[],
): AcpConfigOption | undefined {
  return (
    configOptions.find(
      (opt) =>
        opt &&
        typeof opt === "object" &&
        (opt.category === "thought_level" ||
          opt.category === "reasoning_effort"),
    ) ??
    configOptions.find(
      (opt) =>
        opt &&
        typeof opt === "object" &&
        (opt.id === "thought_level" || opt.id === "reasoning_effort"),
    )
  );
}

function normalizeHostCommands(rawCommands: unknown): ChannelSlashCommand[] {
  if (!Array.isArray(rawCommands)) return [];
  const seen = new Set<string>();
  const out: ChannelSlashCommand[] = [];
  for (const item of rawCommands) {
    if (!item || typeof item !== "object") continue;
    const raw = item as AcpAvailableCommand;
    if (typeof raw.name !== "string") continue;
    if (raw.name.trim().length === 0 || /\s/.test(raw.name)) continue;
    const stripped = raw.name.replace(/^\/+/, "");
    if (stripped.length === 0) continue;
    const name = truncateChars(stripped, MAX_CMD_NAME_CHARS);
    if (RESERVED_DAEMON_COMMAND_NAMES.has(name) || seen.has(name)) continue;
    seen.add(name);
    const description =
      typeof raw.description === "string" && raw.description.trim().length > 0
        ? truncateChars(raw.description.trim(), MAX_CMD_DESC_CHARS)
        : undefined;
    const hintRaw =
      raw.input && typeof raw.input === "object" && typeof raw.input.hint === "string"
        ? raw.input.hint.trim()
        : "";
    const inputHint =
      hintRaw.length > 0 ? truncateChars(hintRaw, MAX_CMD_HINT_CHARS) : undefined;
    out.push({
      name,
      ...(description !== undefined ? { description } : {}),
      ...(inputHint !== undefined ? { inputHint } : {}),
      source: "host",
    });
  }
  return out;
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = Math.min(text.length, maxBytes);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = truncateChars(text, mid);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return truncateChars(text, low);
}

function splitUtf8ByBytes(text: string, maxBytes: number): string[] {
  if (text.length === 0 || maxBytes <= 0) return [];
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
  const parts: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const window = text.slice(offset, offset + maxBytes + 1);
    const piece = truncateUtf8Bytes(window, maxBytes);
    if (piece.length === 0) {
      break;
    }
    parts.push(piece);
    offset += piece.length;
  }
  return parts;
}

function mapToolStepStatus(
  rawStatus: unknown,
  sessionUpdate: string,
  existingStatus?: ToolStepStatus,
): ToolStepStatus {
  if (typeof rawStatus === "string") {
    const normalized = rawStatus.trim().toLowerCase();
    if (normalized === "pending" || normalized === "queued") {
      return "pending";
    }
    if (
      normalized === "in_progress" ||
      normalized === "in-progress" ||
      normalized === "running" ||
      normalized === "executing" ||
      normalized === "started"
    ) {
      return "in_progress";
    }
    if (
      normalized === "completed" ||
      normalized === "complete" ||
      normalized === "done" ||
      normalized === "success" ||
      normalized === "succeeded" ||
      normalized === "finished"
    ) {
      return "completed";
    }
    if (
      normalized === "failed" ||
      normalized === "error" ||
      normalized === "errored" ||
      normalized === "cancelled" ||
      normalized === "canceled" ||
      normalized === "denied" ||
      normalized === "rejected"
    ) {
      return "failed";
    }
  }
  if (existingStatus) {
    return existingStatus;
  }
  return sessionUpdate === "tool_call" ? "pending" : "in_progress";
}

function extractToolUpdateSummary(
  update: AcpSessionUpdateParams["update"],
): string | undefined {
  const candidates: unknown[] = [];
  if (update.summary !== undefined) candidates.push(update.summary);
  if (update.rawOutput !== undefined) candidates.push(update.rawOutput);
  if (update.error !== undefined) candidates.push(update.error);
  if (update.content !== undefined) {
    if (Array.isArray(update.content)) {
      const parts: string[] = [];
      for (const item of update.content) {
        if (typeof item === "string") {
          parts.push(item);
        } else if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          if (typeof obj.text === "string") {
            parts.push(obj.text);
          } else if (
            obj.content &&
            typeof obj.content === "object" &&
            typeof (obj.content as Record<string, unknown>).text === "string"
          ) {
            parts.push(String((obj.content as Record<string, unknown>).text));
          }
        }
      }
      if (parts.length > 0) candidates.push(parts.join(" "));
    } else if (
      typeof update.content === "object" &&
      update.content !== null &&
      typeof update.content.text === "string"
    ) {
      candidates.push(update.content.text);
    } else {
      candidates.push(update.content);
    }
  }
  if (update.rawInput !== undefined) candidates.push(update.rawInput);

  for (const candidate of candidates) {
    const text = oneLineSummary(candidate);
    if (text.length > 0) return text;
  }
  return undefined;
}

function appendCapturedTurnChunk(
  capture: ReplayCaptureBuffer,
  role: "user" | "assistant",
  chunkText: string,
): void {
  if (capture.detached || chunkText.length === 0) return;
  const turns = capture.turns;
  const last = turns[turns.length - 1];
  if (last && last.role === role) {
    if (last.text.length < MAX_RECENT_TURN_CHARS) {
      last.text = truncateChars(last.text + chunkText, MAX_RECENT_TURN_CHARS);
    }
  } else {
    turns.push({
      role,
      text: truncateChars(chunkText, MAX_RECENT_TURN_CHARS),
    });
  }
  while (turns.length > MAX_RECENT_TURNS) {
    turns.shift();
  }
  while (
    turns.length > 1 &&
    Buffer.byteLength(JSON.stringify(turns), "utf8") > MAX_RECENT_TURNS_BYTES
  ) {
    turns.shift();
  }
  if (
    turns.length === 1 &&
    Buffer.byteLength(JSON.stringify(turns), "utf8") > MAX_RECENT_TURNS_BYTES
  ) {
    const overhead = Buffer.byteLength(
      JSON.stringify([{ role: turns[0]!.role, text: "" }]),
      "utf8",
    );
    turns[0]!.text = truncateUtf8Bytes(
      turns[0]!.text,
      Math.max(0, MAX_RECENT_TURNS_BYTES - overhead),
    );
  }
}

interface PendingPermission {
  rpcId: string | number;
  client: AcpClient;
  sessionId: string;
  acpSessionId: string | null;
  toolName: string;
  promptHash: string;
  frame: Record<string, unknown>;
  options: AcpPermissionOption[];
  resolved: boolean;
  isWorker: boolean;
  workerRunId?: string;
  choicesId?: string;
}

interface PendingWorkerMcpChoice {
  choicesId: string;
  runId: string;
  acpSessionId: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

interface QueuedTurn {
  input: InboundMessage;
  isChoiceResponse: boolean;
}

interface QueuedSessionTurn {
  prompt: string;
  runId?: string;
  isFollowUp?: boolean;
}

interface WorkerRunState {
  runId: string;
  acpSessionId: string;
  parentRunId: string | null;
  episodeRootRunId: string | null;
  dispatchDepth: number;
  messageHop: number;
  externalSessionKey?: string;
  cwd: string;
  cancelled: boolean;
  cancelReason?: string;
  terminalEmitted: boolean;
  ws?: HitlWebSocket;
}

interface WorkerSessionEntry {
  sessionId: string;
  client: AcpClient;
  capabilities: AcpAgentCapabilities;
  cwd: string;
  externalSessionKey?: string;
  createdAt: number;
  lastActiveAt: number;
  activeRunId: string | null;
}

interface WorkerProcessEntry {
  id: string;
  client: AcpClient;
  capabilities: AcpAgentCapabilities;
  busySessionIds: Set<string>;
  sessionIds: Set<string>;
  lastUsedAt: number;
}

const DEFAULT_MAX_WORKER_SESSIONS = 8;
const DEFAULT_WORKER_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_WORKER_PROCESSES = 2;

function isConcurrencyBusyError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("cancelled") || msg.includes("canceled")) return false;
  return (
    msg.includes("turn_busy") ||
    msg.includes("busy") ||
    msg.includes("concurrent") ||
    msg.includes("already running") ||
    msg.includes("already active") ||
    msg.includes("in progress") ||
    msg.includes("single turn")
  );
}

interface RunningTurn {
  turnId: string;
  sessionId: string;
  isWorker?: boolean;
  workerRunId?: string;
  chunks: string[];
  delegationMessageId: string | null;
  clientMessageId: string | null;
  replyToolCalled: boolean;
  cancelledByCommand: boolean;
  deltaSeq: number;
  pendingDeltaText: string;
  deltaTimer: ReturnType<typeof setTimeout> | null;
  emittedDeltaBytes: number;
  deltaTruncated: boolean;
  toolSteps: Map<string, ToolStepSummary>;
}

export type BroadcastReplyFn = (
  text: string,
  messageId?: string,
  agentId?: string,
  attachments?: HitlAttachment[],
  opts?: BroadcastReplyOptions,
) => string | number | void;

export interface AcpSessionManagerOptions {
  harness?: string;
  defaultCwd?: string;
  mcpUrl: string;
  mcpToken: string;
  mcpTransport?: McpTransportMode;
  cliScriptPath?: string;
  instanceId: string;
  onPairingCode?: (code: string) => void | Promise<void>;
  transportFactory?: (
    command: string,
    args: string[],
    opts?: { cwd?: string },
  ) => AcpTransport;
  broadcastReplyFn?: BroadcastReplyFn;
  broadcastToCapableFn?: typeof broadcastToCapable;
  sendControlToClientFn?: typeof sendControlToClient;
  unicastFrameFn?: typeof unicastFrame;
  auditFn?: typeof appendAudit;
  processAttachmentsFn?: typeof processAttachments;
  outOfTurnQuietMs?: number;
  crashWindowMs?: number;
  sessionLoadTimeoutMs?: number;
  streamCoalesceMs?: number;
  nowMs?: () => number;
  agyConversationsDir?: string | null;
  concurrentSessions?: boolean;
  maxWorkerSessions?: number;
  workerIdleTtlMs?: number;
  maxWorkerProcesses?: number;
  workerOutboxPath?: string;
  workerGcIntervalMs?: number;
}

export class AcpSessionManager {
  readonly harness: HarnessDefinition;
  readonly defaultCwd: string;
  private readonly mcpUrl: string;
  private readonly mcpToken: string;
  private readonly mcpTransport: McpTransportMode;
  private readonly cliScriptPath: string;
  private readonly instanceId: string;
  private readonly onPairingCodeCb: (code: string) => void | Promise<void>;
  private readonly transportFactory: (
    command: string,
    args: string[],
    opts?: { cwd?: string },
  ) => AcpTransport;
  private readonly broadcastReplyFn: BroadcastReplyFn;
  private readonly broadcastToCapableFn: typeof broadcastToCapable;
  private readonly sendControlToClientFn: typeof sendControlToClient;
  private readonly unicastFrameFn: typeof unicastFrame;
  private readonly auditFn: typeof appendAudit;
  private readonly processAttachmentsFn: typeof processAttachments;
  private readonly outOfTurnQuietMs: number;
  private readonly crashWindowMs: number;
  private readonly sessionLoadTimeoutMs: number;
  private readonly streamCoalesceMs: number;
  private readonly nowMs: () => number;
  private readonly agyConversationsDir: string | null;
  private readonly concurrentSessions: boolean;
  private readonly maxWorkerSessions: number;
  private readonly workerIdleTtlMs: number;
  private readonly maxWorkerProcesses: number;

  private client: AcpClient | null = null;
  private pendingClient: AcpClient | null = null;
  private startPromise: Promise<AcpClient> | null = null;
  private agentCapabilities: AcpAgentCapabilities = {};

  private activeSessionId: string | null = null;
  private activeSessionCwd: string | null = null;
  private activeSessionTitle: string | null = null;

  private turnBusy = false;
  private sessionOpInFlight = false;
  private runningTurn: RunningTurn | null = null;
  private readonly runningTurns = new Map<string, RunningTurn>();
  private cancelRequestedBeforeTurn = false;
  private readonly queue: QueuedTurn[] = [];
  private readonly sessionQueues = new Map<string, QueuedSessionTurn[]>();
  private readonly pendingPermissions: PendingPermission[] = [];
  private readonly pendingPermissionsBySession = new Map<string, PendingPermission[]>();
  private readonly pendingWorkerMcpChoices = new Map<string, PendingWorkerMcpChoice>();
  private readonly openUserChoiceIds = new Set<string>();
  private legacyChoiceSeq = 0;
  private permSeq = 0;
  private turnSeq = 0;
  private workerProcessSeq = 0;

  private readonly workerOutbox: WorkerOutbox;
  private readonly mcpBindings = new Map<string, string>();
  private readonly workerContextBySessionId = new Map<string, WorkerSessionContext>();
  private readonly workerSessions = new Map<string, WorkerSessionEntry>();
  private readonly workerRunsById = new Map<string, WorkerRunState>();
  private readonly workerCreatedSessionIds = new Set<string>();
  private readonly evictedWorkerSessionIds = new Set<string>();
  private readonly workerProcesses: WorkerProcessEntry[] = [];
  private readonly workerProcessWaiters: Array<() => void> = [];
  private readonly processedInboundEventIds = new Set<string>();
  private primarySerializesTurns = false;
  private workerGcTimer: ReturnType<typeof setInterval> | null = null;

  private outOfTurnChunks: string[] = [];
  private outOfTurnSessionId: string | null = null;
  private outOfTurnTimer: ReturnType<typeof setTimeout> | null = null;

  private lastListing: AcpSessionInfo[] = [];
  private sessionCatalog: AcpSessionInfo[] = [];
  private catalogMutationSeq = 0;
  private recentCwds: string[];
  private readonly loadingSessionIds = new Set<string>();
  private readonly inFlightSessionLoads = new Map<string, Promise<void>>();
  private readonly replayCaptureBuffers = new Map<string, ReplayCaptureBuffer>();
  private readonly instructionsDeliveredSessions = new Set<string>();
  private readonly createdSessionIds = new Set<string>();
  private readonly seenToolCalls = new Map<string, AcpPermissionToolCall>();
  private readonly sessionModelsMap = new Map<string, SessionModelState>();
  private readonly sessionCommandsMap = new Map<string, ChannelSlashCommand[]>();
  private static readonly MAX_SEEN_TOOL_CALLS = 500;
  private static readonly MAX_PROCESSED_INBOUND_EVENTS = 1000;

  private crashTimestamps: number[] = [];
  private restartStopped = false;
  private shuttingDown = false;

  constructor(opts: AcpSessionManagerOptions) {
    const harnessName = opts.harness ?? "agy";
    const def = HARNESS_REGISTRY[harnessName];
    if (!def) {
      throw new Error(`Unsupported harness '${harnessName}'`);
    }
    this.harness = def;
    this.defaultCwd = resolvePath(opts.defaultCwd ?? process.cwd());
    this.recentCwds = [this.defaultCwd];
    this.mcpUrl = opts.mcpUrl;
    this.mcpToken = opts.mcpToken;
    this.mcpTransport = opts.mcpTransport ?? "auto";
    this.cliScriptPath =
      opts.cliScriptPath ?? fileURLToPath(new URL("./cli.ts", import.meta.url));
    this.instanceId = opts.instanceId;
    this.onPairingCodeCb = opts.onPairingCode ?? (() => {});
    this.transportFactory = opts.transportFactory ?? spawnAcpTransport;
    this.broadcastReplyFn = opts.broadcastReplyFn ?? broadcastReply;
    this.broadcastToCapableFn = opts.broadcastToCapableFn ?? broadcastToCapable;
    this.sendControlToClientFn = opts.sendControlToClientFn ?? sendControlToClient;
    this.unicastFrameFn = opts.unicastFrameFn ?? unicastFrame;
    this.auditFn = opts.auditFn ?? appendAudit;
    this.processAttachmentsFn = opts.processAttachmentsFn ?? processAttachments;
    this.outOfTurnQuietMs = opts.outOfTurnQuietMs ?? 3000;
    this.crashWindowMs = opts.crashWindowMs ?? 60_000;
    this.sessionLoadTimeoutMs =
      opts.sessionLoadTimeoutMs ?? DEFAULT_SESSION_LOAD_TIMEOUT_MS;
    this.streamCoalesceMs =
      opts.streamCoalesceMs !== undefined && Number.isFinite(opts.streamCoalesceMs)
        ? Math.max(0, opts.streamCoalesceMs)
        : DEFAULT_STREAM_COALESCE_MS;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.concurrentSessions = opts.concurrentSessions ?? def.concurrentSessions;
    this.maxWorkerSessions = opts.maxWorkerSessions ?? DEFAULT_MAX_WORKER_SESSIONS;
    this.workerIdleTtlMs = opts.workerIdleTtlMs ?? DEFAULT_WORKER_IDLE_TTL_MS;
    this.maxWorkerProcesses = opts.maxWorkerProcesses ?? DEFAULT_MAX_WORKER_PROCESSES;
    this.workerOutbox = new WorkerOutbox({
      instanceId: this.instanceId,
      filePath: opts.workerOutboxPath,
      now: this.nowMs,
    });
    if (this.workerIdleTtlMs > 0) {
      const intervalMs =
        opts.workerGcIntervalMs ??
        Math.min(60_000, Math.max(100, Math.floor(this.workerIdleTtlMs / 2)));
      this.workerGcTimer = setInterval(() => {
        void this.runWorkerGc();
      }, intervalMs);
      this.workerGcTimer.unref?.();
    }
    if (this.harness.name !== "agy") {
      this.agyConversationsDir = null;
    } else if (opts.agyConversationsDir !== undefined) {
      this.agyConversationsDir = opts.agyConversationsDir || null;
    } else if (opts.transportFactory) {
      this.agyConversationsDir = null;
    } else {
      this.agyConversationsDir = join(
        process.env.HOME?.trim() || homedir(),
        ".gemini",
        "antigravity-cli",
        "conversations",
      );
    }
  }

  getInboundHandlers(): InboundHandlers {
    return {
      onInbound: (input) => this.handleInbound(input),
      onPairingCode: (code) => this.onPairingCodeCb(code),
      onClientOpen: (send) => this.handleClientOpen(send),
      onClientHello: (ws) => this.handleClientHello(ws),
      onControlFrame: (ws, frame) => this.handleControlFrame(ws, frame),
    };
  }

  getAttributionSessionId(): string | null {
    return this.runningTurn?.sessionId ?? this.activeSessionId;
  }

  getActiveTurnId(): string | null {
    return this.runningTurn?.turnId ?? null;
  }

  effectiveMcpTransport(): "http" | "stdio" {
    if (this.mcpTransport === "http" || this.mcpTransport === "stdio") {
      return this.mcpTransport;
    }
    if (this.agentCapabilities.mcpCapabilities?.http === false) {
      return "stdio";
    }
    return this.harness.defaultMcpTransport;
  }

  onChoicesPresented(choiceId?: string): void {
    const id =
      typeof choiceId === "string" && choiceId.trim().length > 0
        ? choiceId.trim()
        : `__legacy_choice_${++this.legacyChoiceSeq}`;
    this.openUserChoiceIds.add(id);
  }

  onReplySent(acpSessionId?: string | null): void {
    if (
      this.runningTurn &&
      (!acpSessionId || acpSessionId === this.runningTurn.sessionId)
    ) {
      this.runningTurn.replyToolCalled = true;
    }
  }

  getStateSnapshot() {
    return {
      activeSessionId: this.activeSessionId,
      activeSessionCwd: this.activeSessionCwd,
      activeSessionTitle: this.activeSessionTitle,
      turnBusy: this.turnBusy,
      queueDepth: this.queue.length,
      pendingPermissionCount: this.pendingPermissions.length,
      openUserChoices: this.openUserChoiceIds.size,
      outOfTurnBufferedLength: this.outOfTurnChunks.join("").length,
      lastListingCount: this.lastListing.length,
      restartStopped: this.restartStopped,
      workerSessionCount: this.workerSessions.size,
      workerOutboxSize: this.workerOutbox.size(),
      workerProcessCount: this.workerProcesses.length,
    };
  }

  private preMintMcpBindingId(): string {
    return globalThis.crypto.randomUUID();
  }

  private bindMcpSession(mcpBindingId: string, actualAcpSessionId: string): void {
    if (!mcpBindingId || !actualAcpSessionId) return;
    this.mcpBindings.set(mcpBindingId, actualAcpSessionId);
  }

  resolveBoundAcpSessionId(bindingId: string): string | null {
    return this.mcpBindings.get(bindingId) ?? null;
  }

  getWorkerContext(acpSessionId: string): WorkerSessionContext | null {
    return this.workerContextBySessionId.get(acpSessionId) ?? null;
  }

  getWorkerOutbox(): WorkerOutbox {
    return this.workerOutbox;
  }

  private isWorkerSession(sessionId: string): boolean {
    return (
      this.workerContextBySessionId.has(sessionId) ||
      this.workerSessions.has(sessionId) ||
      this.workerCreatedSessionIds.has(sessionId)
    );
  }

  private emitWorkerEvent(frame: HostRunEventFrame): HostRunEventFrame {
    const stored = this.workerOutbox.push(frame);
    this.broadcastToCapableFn(
      "peer_orchestration",
      stored as unknown as Record<string, unknown>,
    );
    return stored;
  }

  private drainWorkerOutboxToClient(ws: HitlWebSocket): number {
    if (!ws.data?.features?.has("peer_orchestration")) return 0;
    const entries = this.workerOutbox.peek();
    let sent = 0;
    for (const entry of entries) {
      if (ws.readyState !== 1) break;
      try {
        const res = ws.send(entry.raw);
        if (typeof res === "number" && res <= 0) break;
        sent++;
      } catch {
        break;
      }
    }
    return sent;
  }

  handleWorkerReplyTool(
    acpSessionId: string,
    text: string,
    attachments?: HitlAttachment[],
  ): boolean {
    const ctx = this.workerContextBySessionId.get(acpSessionId);
    if (!ctx) return false;
    const attSuffix =
      attachments && attachments.length > 0
        ? ` (${attachments.length} attachment${attachments.length === 1 ? "" : "s"}: ${attachments.map((a) => a.fileName ?? a.type).join(", ")})`
        : "";
    this.emitWorkerEvent({
      type: "host_run_event",
      event_id: globalThis.crypto.randomUUID(),
      run_id: ctx.runId,
      acp_session_id: acpSessionId,
      kind: "agent_message",
      pinned: false,
      text: `${text}${attSuffix}`,
      ts: new Date(this.nowMs()).toISOString(),
    });
    return true;
  }

  handleWorkerChoicesTool(
    acpSessionId: string,
    prompt: string,
    choices: string[],
    multiSelect: boolean,
  ): { handled: boolean; frameId?: string } {
    const ctx = this.workerContextBySessionId.get(acpSessionId);
    if (!ctx) return { handled: false };
    void multiSelect;
    const choicesId = `perm-${Date.now()}-${++this.permSeq}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const options = choices.map((label) => ({
      optionId: label,
      name: label,
      kind: "choice",
    }));
    this.pendingWorkerMcpChoices.set(choicesId, {
      choicesId,
      runId: ctx.runId,
      acpSessionId,
      options,
    });
    this.emitWorkerEvent({
      type: "host_run_event",
      event_id: globalThis.crypto.randomUUID(),
      run_id: ctx.runId,
      acp_session_id: acpSessionId,
      kind: "permission_request",
      pinned: true,
      choices_id: choicesId,
      tool_name: "present_choices_to_hitl",
      prompt,
      options,
      ts: new Date(this.nowMs()).toISOString(),
    });
    return { handled: true, frameId: choicesId };
  }

  handleWorkerQuestionsTool(
    acpSessionId: string,
    args: Record<string, unknown>,
  ): { handled: boolean; requestId?: string; error?: string } {
    const ctx = this.workerContextBySessionId.get(acpSessionId);
    if (!ctx) return { handled: false };
    const rawQuestions = args.questions;
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return {
        handled: true,
        error: "`questions` must be a non-empty array",
      };
    }
    const firstQ = rawQuestions[0] as Record<string, unknown> | undefined;
    const firstChoices = Array.isArray(firstQ?.choices)
      ? firstQ.choices.filter((c): c is string => typeof c === "string")
      : [];
    const promptLines = rawQuestions
      .map((q) => {
        if (!q || typeof q !== "object") return "";
        const obj = q as Record<string, unknown>;
        const hdr = typeof obj.header === "string" ? obj.header : "Question";
        const text = typeof obj.question === "string" ? obj.question : "";
        return `${hdr}: ${text}`;
      })
      .filter(Boolean);
    const requestId = globalThis.crypto.randomUUID();
    const options = (firstChoices.length > 0 ? firstChoices : ["Approve", "Reject"]).map(
      (label) => ({
        optionId: label,
        name: label,
        kind: "choice",
      }),
    );
    this.pendingWorkerMcpChoices.set(requestId, {
      choicesId: requestId,
      runId: ctx.runId,
      acpSessionId,
      options,
    });
    this.emitWorkerEvent({
      type: "host_run_event",
      event_id: globalThis.crypto.randomUUID(),
      run_id: ctx.runId,
      acp_session_id: acpSessionId,
      kind: "permission_request",
      pinned: true,
      choices_id: requestId,
      tool_name: "present_questions_to_hitl",
      prompt: promptLines.join("\n"),
      options,
      ts: new Date(this.nowMs()).toISOString(),
    });
    return { handled: true, requestId };
  }

  private buildMcpServer(sessionIdHint?: string): AcpMcpServer {
    if (this.effectiveMcpTransport() === "stdio") {
      const env = [{ name: "HITL_MCP_SHIM_TOKEN", value: this.mcpToken }];
      if (sessionIdHint) {
        env.push({ name: "HITL_MCP_SHIM_SESSION_ID", value: sessionIdHint });
      }
      return {
        name: this.harness.mcpServerName,
        command: process.execPath,
        args: ["run", this.cliScriptPath, "mcp-shim", "--url", this.mcpUrl],
        env,
      };
    }

    const headers = [
      { name: "Authorization", value: `Bearer ${this.mcpToken}` },
    ];
    if (sessionIdHint) {
      headers.push({ name: "X-Hitl-Acp-Session-Id", value: sessionIdHint });
    }
    return {
      type: "http",
      name: this.harness.mcpServerName,
      url: this.mcpUrl,
      headers,
    };
  }

  private buildSessionInitExtensions(): {
    systemPrompt?: AcpSystemPrompt;
    _meta?: Record<string, unknown>;
  } {
    const out: {
      systemPrompt?: AcpSystemPrompt;
      _meta?: Record<string, unknown>;
    } = {};

    if (
      this.harness.systemPromptStrategy === "agy_meta" &&
      this.harness.buildSystemPromptMeta
    ) {
      out._meta = this.harness.buildSystemPromptMeta(DAEMON_INSTRUCTIONS);
    }

    if (
      this.harness.systemPromptStrategy === "acp_system_prompt" ||
      this.agentCapabilities.sessionCapabilities?.systemPrompt
    ) {
      out.systemPrompt = {
        mode: "append",
        content: [{ type: "text", text: DAEMON_INSTRUCTIONS }],
      };
    }

    return out;
  }

  private needsFirstPromptInstructions(sessionId: string): boolean {
    return (
      this.harness.systemPromptStrategy === "first_prompt_prefix" &&
      !this.agentCapabilities.sessionCapabilities?.systemPrompt &&
      !this.instructionsDeliveredSessions.has(sessionId)
    );
  }

  async start(): Promise<AcpClient> {
    return this.ensureClient();
  }

  private async ensureClient(): Promise<AcpClient> {
    if (this.client && !this.client.isClosed) {
      return this.client;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.shuttingDown) {
      throw new Error("Daemon is shutting down");
    }
    if (this.restartStopped) {
      throw new Error(
        `Harness ${this.harness.name} automatic restart stopped after repeated crashes`,
      );
    }

    this.startPromise = (async () => {
      const launch = resolveHarnessLaunch(this.harness);
      const transport = this.transportFactory(
        launch.command,
        launch.args,
        { cwd: this.defaultCwd },
      );
      const client = new AcpClient(transport);
      this.pendingClient = client;
      client.onSessionUpdate((params) => this.handleSessionUpdate(params));
      client.onPermissionRequest((id, params) =>
        this.handlePermissionRequest(client, id, params),
      );
      client.onExit((code, signal) => this.handleHarnessExit(client, code, signal));

      try {
        const initRes = await client.initialize();
        if (this.shuttingDown) {
          await client.close().catch(() => {});
          throw new Error("Daemon shut down during harness initialization");
        }
        this.agentCapabilities = initRes.agentCapabilities ?? {};
        this.client = client;
        this.pendingClient = null;
        return client;
      } catch (err) {
        this.pendingClient = null;
        await client.close().catch(() => {});
        throw err;
      }
    })();

    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private emitReplyAudit(text: string, acpSessionId: string | null): void {
    this.auditFn({
      ts: new Date(this.nowMs()).toISOString(),
      instance_id: this.instanceId,
      direction: "cc_to_phone",
      kind: "reply",
      tool_name: null,
      approval: null,
      prompt_hash: sha256Hex(text),
      duration_ms: null,
      attachment_count: 0,
      attachment_bytes: 0,
      acp_session_id: acpSessionId,
    }).catch((err) =>
      process.stderr.write(
        `[hitl-channel] audit failed: ${err instanceof Error ? err.message : err}\n`,
      ),
    );
  }

  private emitPermissionAudit(
    toolName: string,
    approval: "auto" | "user_approved" | "user_denied" | "cancelled",
    promptHash: string,
    acpSessionId: string | null,
  ): void {
    this.auditFn({
      ts: new Date(this.nowMs()).toISOString(),
      instance_id: this.instanceId,
      direction: "harness_to_phone",
      kind: "permission",
      tool_name: toolName,
      approval,
      prompt_hash: promptHash,
      duration_ms: null,
      attachment_count: 0,
      attachment_bytes: 0,
      acp_session_id: acpSessionId,
    }).catch((err) =>
      process.stderr.write(
        `[hitl-channel] audit failed: ${err instanceof Error ? err.message : err}\n`,
      ),
    );
  }

  private sendStandaloneReply(
    text: string,
    acpSessionId: string | null,
    messageId?: string,
    opts?: Omit<BroadcastReplyOptions, "acpSessionId">,
  ): string | null {
    const mergedOpts: BroadcastReplyOptions = {
      ...(acpSessionId ? { acpSessionId } : {}),
      ...(opts ?? {}),
    };
    const rawId = this.broadcastReplyFn(
      text,
      messageId,
      undefined,
      undefined,
      Object.keys(mergedOpts).length > 0 ? mergedOpts : undefined,
    );
    this.emitReplyAudit(text, acpSessionId);
    if (typeof rawId === "string" && rawId.length > 0) return rawId;
    if (typeof rawId === "number") return String(rawId);
    return null;
  }

  private computeTurnStateValue(): TurnStateValue {
    if (this.pendingPermissions.some((p) => !p.resolved)) {
      return "waiting_approval";
    }
    if (this.runningTurn !== null) {
      return "running";
    }
    return "idle";
  }

  private buildTurnStateFrame(opts?: {
    sessionId?: string | null;
    turnId?: string;
    state?: TurnStateValue;
    finalReplyId?: string | null;
  }): TurnStateFrame {
    const state = opts?.state ?? this.computeTurnStateValue();
    const sessionId =
      opts?.sessionId !== undefined
        ? opts.sessionId
        : (this.runningTurn?.sessionId ?? this.activeSessionId ?? null);
    const turnId = opts?.turnId ?? this.runningTurn?.turnId;
    return {
      type: "turn_state",
      sessionId,
      ...(turnId ? { turnId } : {}),
      state,
      queueDepth: this.queue.length,
      ...(opts?.finalReplyId !== undefined
        ? { finalReplyId: opts.finalReplyId }
        : {}),
    };
  }

  private emitTurnState(opts?: {
    sessionId?: string | null;
    turnId?: string;
    state?: TurnStateValue;
    finalReplyId?: string | null;
  }): void {
    const frame = this.buildTurnStateFrame(opts);
    this.broadcastToCapableFn(
      "streaming",
      frame as unknown as Record<string, unknown>,
    );
  }

  private clearTurnDeltaTimer(turn: RunningTurn): void {
    if (turn.deltaTimer) {
      clearTimeout(turn.deltaTimer);
      turn.deltaTimer = null;
    }
  }

  private emitStreamDeltaFrame(
    turn: RunningTurn,
    delta: string,
    opts?: { truncated?: boolean },
  ): void {
    const frame: StreamDeltaFrame = {
      type: "stream_delta",
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      seq: ++turn.deltaSeq,
      delta,
      ...(opts?.truncated ? { truncated: true } : {}),
    };
    this.broadcastToCapableFn(
      "streaming",
      frame as unknown as Record<string, unknown>,
    );
  }

  private flushPendingTurnDelta(turn: RunningTurn): void {
    this.clearTurnDeltaTimer(turn);
    const pending = turn.pendingDeltaText;
    turn.pendingDeltaText = "";
    if (pending.length === 0 || turn.deltaTruncated) return;

    const remainingBytes = Math.max(
      0,
      MAX_TURN_DELTA_BYTES - turn.emittedDeltaBytes,
    );
    const pendingBytes = Buffer.byteLength(pending, "utf8");

    if (pendingBytes <= remainingBytes) {
      const slices = splitUtf8ByBytes(pending, MAX_STREAM_DELTA_FRAME_BYTES);
      for (const slice of slices) {
        turn.emittedDeltaBytes += Buffer.byteLength(slice, "utf8");
        this.emitStreamDeltaFrame(turn, slice);
      }
      return;
    }

    const allowed = truncateUtf8Bytes(pending, remainingBytes);
    const slices = splitUtf8ByBytes(allowed, MAX_STREAM_DELTA_FRAME_BYTES);
    turn.deltaTruncated = true;
    if (slices.length === 0) {
      this.emitStreamDeltaFrame(turn, "", { truncated: true });
      return;
    }
    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i]!;
      const isLast = i === slices.length - 1;
      turn.emittedDeltaBytes += Buffer.byteLength(slice, "utf8");
      this.emitStreamDeltaFrame(
        turn,
        slice,
        isLast ? { truncated: true } : undefined,
      );
    }
  }

  private queueStreamDelta(turn: RunningTurn, chunkText: string): void {
    if (chunkText.length === 0 || turn.deltaTruncated) return;
    turn.pendingDeltaText += chunkText;
    const totalBytes =
      turn.emittedDeltaBytes + Buffer.byteLength(turn.pendingDeltaText, "utf8");
    if (this.streamCoalesceMs <= 0 || totalBytes > MAX_TURN_DELTA_BYTES) {
      this.flushPendingTurnDelta(turn);
      return;
    }
    if (!turn.deltaTimer) {
      turn.deltaTimer = setTimeout(() => {
        turn.deltaTimer = null;
        if (this.runningTurn === turn) {
          this.flushPendingTurnDelta(turn);
        }
      }, this.streamCoalesceMs);
    }
  }

  private handleRunningTurnToolUpdate(
    turn: RunningTurn,
    update: AcpSessionUpdateParams["update"],
  ): void {
    const toolCallId =
      typeof update.toolCallId === "string" ? update.toolCallId.trim() : "";
    if (!toolCallId) return;

    const existing = turn.toolSteps.get(toolCallId);
    const seen = this.seenToolCalls.get(`${turn.sessionId}:${toolCallId}`);

    const rawName =
      typeof update.name === "string" && update.name.trim().length > 0
        ? update.name.trim()
        : existing?.name;
    const name = rawName || deriveToolName(update, seen);

    const rawTitle =
      typeof update.title === "string" && update.title.trim().length > 0
        ? update.title.trim()
        : existing?.title;
    const title = rawTitle || name;

    const kind =
      typeof update.kind === "string" && update.kind.trim().length > 0
        ? update.kind.trim()
        : existing?.kind;

    const status = mapToolStepStatus(
      update.status,
      update.sessionUpdate,
      existing?.status,
    );

    const extractedSummary = extractToolUpdateSummary(update);
    const rawSummary = extractedSummary ?? existing?.summary;
    const ephemeralSummary = rawSummary
      ? truncateChars(rawSummary, MAX_EPHEMERAL_TOOL_SUMMARY_CHARS)
      : undefined;
    const durableSummary = rawSummary
      ? truncateChars(rawSummary, MAX_DURABLE_TOOL_SUMMARY_CHARS)
      : undefined;

    const durableStep: ToolStepSummary = {
      toolCallId,
      name,
      title,
      ...(kind ? { kind } : {}),
      status,
      ...(durableSummary ? { summary: durableSummary } : {}),
    };

    if (!turn.toolSteps.has(toolCallId) && turn.toolSteps.size >= MAX_TOOL_STEPS) {
      const oldestKey = turn.toolSteps.keys().next().value;
      if (oldestKey !== undefined) {
        turn.toolSteps.delete(oldestKey);
      }
    }
    turn.toolSteps.set(toolCallId, durableStep);

    const frame: ToolProgressFrame = {
      type: "tool_progress",
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      toolCallId,
      name,
      title,
      ...(kind ? { kind } : {}),
      status,
      ...(ephemeralSummary ? { summary: ephemeralSummary } : {}),
    };
    this.broadcastToCapableFn(
      "streaming",
      frame as unknown as Record<string, unknown>,
    );
  }

  private finalizeToolSteps(
    turn: RunningTurn,
    cancelled: boolean,
  ): ToolStepSummary[] {
    const out: ToolStepSummary[] = [];
    for (const step of turn.toolSteps.values()) {
      if (step.status === "pending" || step.status === "in_progress") {
        out.push({
          ...step,
          status: "failed",
          summary: cancelled ? "Cancelled" : "Interrupted",
        });
      } else {
        out.push({ ...step });
      }
    }
    return out;
  }

  private emitChoicesSettled(params: {
    frameIds: string[];
    acpSessionId: string | null;
    reason: "cancelled" | "answered";
    selectedLabel?: string;
  }): void {
    if (params.frameIds.length === 0) return;
    const frame: ChoicesSettledFrame = {
      type: "choices_settled",
      frameIds: params.frameIds,
      acpSessionId: params.acpSessionId,
      reason: params.reason,
      ...(params.selectedLabel ? { selectedLabel: params.selectedLabel } : {}),
    };
    this.broadcastToCapableFn(
      "choices_settled",
      frame as unknown as Record<string, unknown>,
    );
  }

  private touchRecentCwd(cwd: string): void {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    const resolved = resolvePath(trimmed);
    this.recentCwds = [
      resolved,
      ...this.recentCwds.filter((d) => d !== resolved),
    ].slice(0, MAX_RECENT_CWDS);
  }

  private mergeListedCwds(sorted: AcpSessionInfo[]): void {
    for (const entry of sorted) {
      if (this.recentCwds.length >= MAX_RECENT_CWDS) break;
      if (typeof entry.cwd === "string" && entry.cwd.trim().length > 0) {
        const resolved = resolvePath(entry.cwd.trim());
        if (!this.recentCwds.includes(resolved)) {
          this.recentCwds.push(resolved);
        }
      }
    }
  }

  private sortSessionsDesc(sessions: AcpSessionInfo[]): AcpSessionInfo[] {
    return [...sessions].sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
  }

  private async readLocalAgySessionIds(): Promise<Set<string> | null> {
    if (!this.agyConversationsDir) {
      return null;
    }
    try {
      const entries = await readdir(this.agyConversationsDir);
      const ids = new Set<string>();
      for (const entry of entries) {
        if (entry.endsWith(".db") || entry.endsWith(".pb")) {
          const id = entry.slice(0, -3);
          if (id.length > 0) {
            ids.add(id);
          }
        }
      }
      return ids;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return null;
      }
      process.stderr.write(
        `[hitl-channel] failed to read agy conversations dir '${this.agyConversationsDir}': ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return null;
    }
  }

  private isKnownLocalSession(
    sessionId: string,
    localIds: Set<string>,
  ): boolean {
    return (
      localIds.has(sessionId) ||
      sessionId === this.activeSessionId ||
      this.createdSessionIds.has(sessionId)
    );
  }

  private async filterResumableSessions(
    sessions: AcpSessionInfo[],
  ): Promise<AcpSessionInfo[]> {
    const nonWorker = sessions.filter((s) => !this.isWorkerSession(s.sessionId));
    const localIds = await this.readLocalAgySessionIds();
    if (localIds === null) {
      return nonWorker;
    }
    return nonWorker.filter((s) => this.isKnownLocalSession(s.sessionId, localIds));
  }

  private async isLocallyResumableAgySession(
    sessionId: string,
  ): Promise<boolean> {
    const localIds = await this.readLocalAgySessionIds();
    if (localIds === null) {
      return true;
    }
    return this.isKnownLocalSession(sessionId, localIds);
  }

  private updateCatalogFromList(sessions: AcpSessionInfo[]): AcpSessionInfo[] {
    const sorted = this.sortSessionsDesc(sessions);
    this.sessionCatalog = sorted;
    this.catalogMutationSeq++;
    this.mergeListedCwds(sorted);
    return sorted;
  }

  private upsertCatalogSession(entry: AcpSessionInfo): void {
    const rest = this.sessionCatalog.filter(
      (s) => s.sessionId !== entry.sessionId,
    );
    this.sessionCatalog = this.sortSessionsDesc([entry, ...rest]);
    this.catalogMutationSeq++;
  }

  private buildSessionListFrame(requestId?: string): SessionListFrame {
    const sorted = this.sortSessionsDesc(
      this.sessionCatalog.filter((s) => !this.isWorkerSession(s.sessionId)),
    );
    let capped = sorted.slice(0, MAX_SESSION_LIST_SIZE);
    if (
      this.activeSessionId &&
      !capped.some((s) => s.sessionId === this.activeSessionId)
    ) {
      const activeEntry: AcpSessionInfo = sorted.find(
        (s) => s.sessionId === this.activeSessionId,
      ) ?? {
        sessionId: this.activeSessionId,
        ...(this.activeSessionTitle ? { title: this.activeSessionTitle } : {}),
        cwd: this.activeSessionCwd ?? this.defaultCwd,
      };
      if (capped.length >= MAX_SESSION_LIST_SIZE) {
        capped = [
          ...capped.slice(0, MAX_SESSION_LIST_SIZE - 1),
          activeEntry,
        ];
      } else {
        capped.push(activeEntry);
      }
    }

    const sessions: SessionListEntry[] = capped.map((s) => ({
      sessionId: s.sessionId,
      ...(typeof s.title === "string" && s.title.length > 0
        ? { title: s.title }
        : {}),
      ...(typeof s.cwd === "string" && s.cwd.length > 0 ? { cwd: s.cwd } : {}),
      ...(typeof s.updatedAt === "string" && s.updatedAt.length > 0
        ? { updatedAt: s.updatedAt }
        : {}),
    }));

    return {
      type: "session_list",
      sessions,
      activeSessionId: this.activeSessionId,
      defaultCwd: this.defaultCwd,
      recentCwds: [...this.recentCwds],
      ...(requestId ? { requestId } : {}),
    };
  }

  private buildModelsStateFrame(
    sessionId: string | null,
    requestId?: string,
  ): ModelsStateFrame {
    const state = sessionId ? this.sessionModelsMap.get(sessionId) : undefined;
    return {
      type: "models_state",
      sessionId,
      currentModelId: state?.currentModelId ?? null,
      availableModels: state ? [...state.availableModels] : [],
      ...(requestId ? { requestId } : {}),
    };
  }

  private buildCommandsListFrame(sessionId: string | null): CommandsListFrame {
    const hostCommands = sessionId
      ? (this.sessionCommandsMap.get(sessionId) ?? [])
      : [];
    const maxHost = Math.max(0, MAX_COMMANDS_COUNT - DAEMON_SLASH_COMMANDS.length);
    return {
      type: "commands_list",
      sessionId,
      commands: [...hostCommands.slice(0, maxHost), ...DAEMON_SLASH_COMMANDS],
    };
  }

  private broadcastModelsState(sessionId: string | null, requestId?: string): void {
    this.broadcastToCapableFn(
      "models",
      this.buildModelsStateFrame(sessionId, requestId) as unknown as Record<
        string,
        unknown
      >,
    );
  }

  private broadcastCommandsList(sessionId: string | null): void {
    this.broadcastToCapableFn(
      "commands",
      this.buildCommandsListFrame(sessionId) as unknown as Record<string, unknown>,
    );
  }

  private recordSessionMetadata(sessionId: string, res: unknown): void {
    if (!sessionId || !res || typeof res !== "object") return;
    const obj = res as {
      models?: AcpSessionModels;
      configOptions?: AcpConfigOption[];
    };

    const rawModels =
      obj.models && typeof obj.models === "object" ? obj.models : undefined;
    const normalizedFromModels = Array.isArray(rawModels?.availableModels)
      ? normalizeChannelModels(rawModels.availableModels)
      : [];

    if (normalizedFromModels.length > 0) {
      const currentModelId = normalizeModelId(rawModels?.currentModelId);
      this.sessionModelsMap.set(sessionId, {
        selectionMethod: "set_model",
        currentModelId,
        allAvailableModels: normalizedFromModels,
        availableModels: capAvailableModels(normalizedFromModels, currentModelId),
        knownModelIds: new Set(normalizedFromModels.map((m) => m.modelId)),
      });
      return;
    }

    const configOptions = Array.isArray(obj.configOptions)
      ? obj.configOptions
      : undefined;
    if (configOptions) {
      const modelOpt = findModelConfigOption(configOptions);
      if (modelOpt && Array.isArray(modelOpt.options)) {
        const normalizedFromConfig = normalizeConfigOptionModels(modelOpt.options);
        if (normalizedFromConfig.length > 0) {
          const currentModelId = normalizeModelId(modelOpt.currentValue);
          const configOptionId =
            typeof modelOpt.id === "string" && modelOpt.id.trim().length > 0
              ? modelOpt.id.trim()
              : "model";
          this.sessionModelsMap.set(sessionId, {
            selectionMethod: "set_config_option",
            configOptionId,
            currentModelId,
            allAvailableModels: normalizedFromConfig,
            availableModels: capAvailableModels(
              normalizedFromConfig,
              currentModelId,
            ),
            knownModelIds: new Set(normalizedFromConfig.map((m) => m.modelId)),
          });
        }
      }
    }
  }

  private broadcastSessionChange(opts?: {
    recentTurns?: RecentTurnSummary[];
    requestId?: string;
  }): void {
    const switchedFrame: SessionSwitchedFrame = {
      type: "session_switched",
      sessionId: this.activeSessionId,
      title: this.activeSessionTitle,
      cwd: this.activeSessionCwd,
      ...(opts?.recentTurns !== undefined
        ? { recentTurns: opts.recentTurns }
        : {}),
      ...(opts?.requestId ? { requestId: opts.requestId } : {}),
    };
    this.broadcastToCapableFn(
      "sessions",
      switchedFrame as unknown as Record<string, unknown>,
    );
    this.broadcastToCapableFn(
      "sessions",
      this.buildSessionListFrame() as unknown as Record<string, unknown>,
    );
    this.broadcastModelsState(this.activeSessionId);
    this.broadcastCommandsList(this.activeSessionId);
  }

  private commitActiveSessionSwitch(params: {
    sessionId: string;
    cwd: string;
    title: string | null;
    recentTurns?: RecentTurnSummary[];
    requestId?: string;
  }): void {
    this.flushOutOfTurnBuffer();
    this.activeSessionId = params.sessionId;
    this.activeSessionCwd = params.cwd;
    this.activeSessionTitle = params.title;
    this.openUserChoiceIds.clear();
    this.touchRecentCwd(params.cwd);
    this.upsertCatalogSession({
      sessionId: params.sessionId,
      cwd: params.cwd,
      ...(params.title ? { title: params.title } : {}),
      updatedAt: new Date(this.nowMs()).toISOString(),
    });
    this.broadcastSessionChange({
      ...(params.recentTurns !== undefined
        ? { recentTurns: params.recentTurns }
        : {}),
      ...(params.requestId ? { requestId: params.requestId } : {}),
    });
  }

  private sendSessionError(
    ws: HitlWebSocket,
    err: Omit<SessionErrorFrame, "type">,
  ): void {
    const frame: SessionErrorFrame = {
      type: "session_error",
      action: err.action,
      code: err.code,
      message: err.message,
      ...(err.requestId ? { requestId: err.requestId } : {}),
    };
    const requiredFeature =
      err.action === "session_set_model" ? "models" : "sessions";
    this.sendControlToClientFn(
      ws,
      frame as unknown as Record<string, unknown>,
      requiredFeature,
    );
  }

  private handleClientHello(ws: HitlWebSocket): void {
    if (ws.data?.features?.has("sessions")) {
      this.sendControlToClientFn(
        ws,
        this.buildSessionListFrame() as unknown as Record<string, unknown>,
        "sessions",
      );
    }
    if (
      ws.data?.features?.has("models") &&
      this.activeSessionId &&
      this.sessionModelsMap.has(this.activeSessionId)
    ) {
      this.sendControlToClientFn(
        ws,
        this.buildModelsStateFrame(this.activeSessionId) as unknown as Record<
          string,
          unknown
        >,
        "models",
      );
    }
    if (ws.data?.features?.has("commands")) {
      this.sendControlToClientFn(
        ws,
        this.buildCommandsListFrame(this.activeSessionId) as unknown as Record<
          string,
          unknown
        >,
        "commands",
      );
    }
    if (ws.data?.features?.has("streaming")) {
      const turn = this.runningTurn;
      if (turn) {
        // Flush buffered deltas to already-connected clients before reading
        // deltaSeq, without sending a duplicate non-reset delta to this ws.
        const features = ws.data.features;
        features.delete("streaming");
        try {
          this.flushPendingTurnDelta(turn);
        } finally {
          features.add("streaming");
        }
      }

      this.sendControlToClientFn(
        ws,
        this.buildTurnStateFrame() as unknown as Record<string, unknown>,
        "streaming",
      );

      if (turn) {
        const accumulated = turn.chunks.join("");
        const totalBytes = Buffer.byteLength(accumulated, "utf8");
        const truncated = totalBytes > MAX_RECONNECT_SNAPSHOT_BYTES;
        const snapshot = truncated
          ? truncateUtf8Bytes(accumulated, MAX_RECONNECT_SNAPSHOT_BYTES)
          : accumulated;
        const snapshotFrame: StreamDeltaFrame = {
          type: "stream_delta",
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          seq: turn.deltaSeq,
          delta: snapshot,
          reset: true,
          ...(truncated ? { truncated: true } : {}),
        };
        this.sendControlToClientFn(
          ws,
          snapshotFrame as unknown as Record<string, unknown>,
          "streaming",
        );

        for (const step of turn.toolSteps.values()) {
          const progressFrame: ToolProgressFrame = {
            type: "tool_progress",
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            toolCallId: step.toolCallId,
            name: step.name,
            title: step.title,
            ...(step.kind ? { kind: step.kind } : {}),
            status: step.status,
            ...(step.summary ? { summary: step.summary } : {}),
          };
          this.sendControlToClientFn(
            ws,
            progressFrame as unknown as Record<string, unknown>,
            "streaming",
          );
        }
      }
    }
    if (ws.data?.features?.has("peer_orchestration")) {
      this.drainWorkerOutboxToClient(ws);
    }
  }

  private async handleControlFrame(
    ws: HitlWebSocket,
    frame: Record<string, unknown>,
  ): Promise<void> {
    const frameType = typeof frame.type === "string" ? frame.type : undefined;
    const requestId =
      typeof frame.requestId === "string" && frame.requestId.trim().length > 0
        ? frame.requestId.trim()
        : undefined;

    if (frameType === "session_list_request") {
      if (!this.turnBusy && !this.sessionOpInFlight) {
        const seqBefore = this.catalogMutationSeq;
        try {
          const client = await this.ensureClient();
          try {
            const res = await client.sessionList({});
            const filtered = await this.filterResumableSessions(
              res.sessions ?? [],
            );
            // Skip overwriting if a concurrent session_new/session_resume
            // updated the catalog while session/list was in flight.
            if (
              this.catalogMutationSeq === seqBefore &&
              !this.turnBusy &&
              !this.sessionOpInFlight
            ) {
              this.updateCatalogFromList(filtered);
            }
          } catch {
            // Gracefully reuse cached listing when session/list is unsupported or fails
          }
        } catch (err) {
          if (this.sessionCatalog.length === 0 && !this.activeSessionId) {
            this.sendSessionError(ws, {
              action: "session_list_request",
              code: "load_failed",
              message: err instanceof Error ? err.message : String(err),
              requestId,
            });
            return;
          }
        }
      }
      this.sendControlToClientFn(
        ws,
        this.buildSessionListFrame(requestId) as unknown as Record<string, unknown>,
        "sessions",
      );
      return;
    }

    if (frameType === "session_new") {
      await this.handleWsSessionNew(ws, frame, requestId);
      return;
    }

    if (frameType === "session_resume") {
      await this.handleWsSessionResume(ws, frame, requestId);
      return;
    }

    if (frameType === "cancel_turn") {
      const requestedSessionId =
        typeof frame.sessionId === "string" && frame.sessionId.trim().length > 0
          ? frame.sessionId.trim()
          : undefined;
      this.cancelActiveTurn({
        notifyWhenIdle: false,
        sessionIdFilter: requestedSessionId,
      });
      return;
    }

    if (frameType === "session_set_model") {
      await this.handleWsSessionSetModel(ws, frame, requestId);
      return;
    }

    if (frameType === "host_run_start") {
      await this.handleHostRunStart(ws, frame as unknown as HostRunStartFrame);
      return;
    }

    if (frameType === "host_run_message") {
      await this.handleHostRunMessage(ws, frame as unknown as HostRunMessageFrame);
      return;
    }

    if (frameType === "host_run_cancel") {
      await this.handleHostRunCancel(ws, frame as unknown as HostRunCancelFrame);
      return;
    }

    if (frameType === "host_run_ack") {
      this.handleHostRunAck(frame as unknown as HostRunAckFrame);
      return;
    }

    if (frameType === "phone_run_wake") {
      await this.handlePhoneRunWake(ws, frame as unknown as PhoneRunWakeFrame);
      return;
    }
  }

  private async handleWsSessionSetModel(
    ws: HitlWebSocket,
    frame: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    if (this.turnBusy || this.sessionOpInFlight) {
      this.sendSessionError(ws, {
        action: "session_set_model",
        code: "turn_busy",
        message: this.turnBusy
          ? "Cannot switch models while a turn is running."
          : "Another session operation is currently in progress.",
        requestId,
      });
      return;
    }

    const rawModelId =
      typeof frame.modelId === "string" ? frame.modelId.trim() : "";
    if (!rawModelId || rawModelId.length > MAX_MODEL_ID_CHARS) {
      this.sendSessionError(ws, {
        action: "session_set_model",
        code: "invalid_model",
        message: !rawModelId
          ? "modelId is required."
          : `modelId exceeds ${MAX_MODEL_ID_CHARS} characters.`,
        requestId,
      });
      return;
    }

    const requestedSessionId =
      typeof frame.sessionId === "string" && frame.sessionId.trim().length > 0
        ? frame.sessionId.trim()
        : undefined;
    if (!this.activeSessionId) {
      this.sendSessionError(ws, {
        action: "session_set_model",
        code: "load_failed",
        message: "No active session to switch model on.",
        requestId,
      });
      return;
    }
    if (requestedSessionId && requestedSessionId !== this.activeSessionId) {
      this.sendSessionError(ws, {
        action: "session_set_model",
        code: "load_failed",
        message: `Session mismatch: active session is '${this.activeSessionId}', requested '${requestedSessionId}'.`,
        requestId,
      });
      return;
    }

    const targetSessionId = this.activeSessionId;
    const state = this.sessionModelsMap.get(targetSessionId);
    if (
      state &&
      state.availableModels.length > 0 &&
      !state.knownModelIds.has(rawModelId)
    ) {
      this.sendSessionError(ws, {
        action: "session_set_model",
        code: "invalid_model",
        message: `Unknown model '${rawModelId}' for active session '${targetSessionId}'.`,
        requestId,
      });
      return;
    }

    this.sessionOpInFlight = true;
    try {
      const client = await this.ensureClient();
      if (state?.selectionMethod === "set_config_option" && state.configOptionId) {
        await client.sessionSetConfigOption({
          sessionId: targetSessionId,
          configId: state.configOptionId,
          value: rawModelId,
        });
      } else {
        await client.sessionSetModel({
          sessionId: targetSessionId,
          modelId: rawModelId,
        });
      }

      const confirmedModelId = rawModelId;
      if (state) {
        state.currentModelId = confirmedModelId;
        state.availableModels = capAvailableModels(
          state.allAvailableModels,
          confirmedModelId,
        );
      } else {
        this.sessionModelsMap.set(targetSessionId, {
          selectionMethod: "set_model",
          currentModelId: confirmedModelId,
          allAvailableModels: [],
          availableModels: [],
          knownModelIds: new Set([confirmedModelId]),
        });
      }
      this.broadcastModelsState(targetSessionId, requestId);
    } catch (err) {
      const isInvalidModel =
        err instanceof AcpRpcError && (err.code === -32601 || err.code === -32602);
      this.sendSessionError(ws, {
        action: "session_set_model",
        code: isInvalidModel ? "invalid_model" : "load_failed",
        message: `Failed to switch model to '${rawModelId}': ${
          err instanceof Error ? err.message : String(err)
        }`,
        requestId,
      });
    } finally {
      this.sessionOpInFlight = false;
      void this.drainQueue();
    }
  }

  private async handleWsSessionNew(
    ws: HitlWebSocket,
    frame: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    if (this.turnBusy || this.sessionOpInFlight) {
      this.sendSessionError(ws, {
        action: "session_new",
        code: "turn_busy",
        message: this.turnBusy
          ? "Cannot create a new session while a turn is running."
          : "Another session operation is currently in progress.",
        requestId,
      });
      return;
    }

    const rawCwd =
      typeof frame.cwd === "string" && frame.cwd.trim().length > 0
        ? frame.cwd.trim()
        : this.defaultCwd;
    const absCwd = expandHomeAndResolve(rawCwd, this.defaultCwd);

    this.sessionOpInFlight = true;
    try {
      try {
        const st = await stat(absCwd);
        if (!st.isDirectory()) {
          this.sendSessionError(ws, {
            action: "session_new",
            code: "invalid_cwd",
            message: `Not a directory: ${absCwd}`,
            requestId,
          });
          return;
        }
        await access(absCwd, constants.R_OK | constants.X_OK);
      } catch (err) {
        this.sendSessionError(ws, {
          action: "session_new",
          code: "invalid_cwd",
          message: `Directory is not accessible (${absCwd}): ${
            err instanceof Error ? err.message : String(err)
          }`,
          requestId,
        });
        return;
      }

      const client = await this.ensureClient();
      this.flushOutOfTurnBuffer();
      const mcpBindingId = this.preMintMcpBindingId();
      const res = await client.sessionNew({
        cwd: absCwd,
        mcpServers: [this.buildMcpServer(mcpBindingId)],
        ...this.buildSessionInitExtensions(),
      });
      this.bindMcpSession(mcpBindingId, res.sessionId);
      this.createdSessionIds.add(res.sessionId);
      this.activeSessionId = res.sessionId;
      this.activeSessionCwd = absCwd;
      this.activeSessionTitle = null;
      this.openUserChoiceIds.clear();
      this.touchRecentCwd(absCwd);
      this.upsertCatalogSession({
        sessionId: res.sessionId,
        cwd: absCwd,
        updatedAt: new Date(this.nowMs()).toISOString(),
      });
      this.recordSessionMetadata(res.sessionId, res);
      this.broadcastSessionChange({ requestId });
    } catch (err) {
      this.sendSessionError(ws, {
        action: "session_new",
        code: "load_failed",
        message: `Failed to create session: ${
          err instanceof Error ? err.message : String(err)
        }`,
        requestId,
      });
    } finally {
      this.sessionOpInFlight = false;
      void this.drainQueue();
    }
  }

  private async performSessionLoadWithTimeout(
    ws: HitlWebSocket,
    client: AcpClient,
    sessionId: string,
    resumeParams: {
      sessionId: string;
      cwd: string;
      mcpServers: AcpMcpServer[];
      [key: string]: unknown;
    },
    requestId: string | undefined,
    capture?: ReplayCaptureBuffer,
  ): Promise<
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; timedOut: boolean; error: unknown }
  > {
    if (capture) {
      this.replayCaptureBuffers.set(sessionId, capture);
    }
    this.loadingSessionIds.add(sessionId);

    const loadPromise = client.sessionLoad(resumeParams);
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const trackedPromise = loadPromise
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        settled = true;
        if (this.inFlightSessionLoads.get(sessionId) === trackedPromise) {
          this.inFlightSessionLoads.delete(sessionId);
          this.loadingSessionIds.delete(sessionId);
        }
        if (capture && this.replayCaptureBuffers.get(sessionId) === capture) {
          this.replayCaptureBuffers.delete(sessionId);
        }
      });
    this.inFlightSessionLoads.set(sessionId, trackedPromise);

    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new Error(
              `session/load timed out after ${this.sessionLoadTimeoutMs}ms`,
            ),
          );
        }, this.sessionLoadTimeoutMs);
        loadPromise.then(
          (res) => {
            if (timer) clearTimeout(timer);
            resolve(res ?? {});
          },
          (err) => {
            if (timer) clearTimeout(timer);
            reject(err);
          },
        );
      });
      if (!settled) {
        await trackedPromise;
      }
      return { ok: true, result };
    } catch (err) {
      if (timedOut) {
        if (capture) {
          capture.detached = true;
          if (this.replayCaptureBuffers.get(sessionId) === capture) {
            this.replayCaptureBuffers.delete(sessionId);
          }
        }
        this.sendSessionError(ws, {
          action: "session_resume",
          code: "load_timeout",
          message: `Timed out loading session '${sessionId}' after ${this.sessionLoadTimeoutMs}ms`,
          requestId,
        });
        return { ok: false, timedOut: true, error: err };
      }

      if (!settled) {
        await trackedPromise;
      }
      if (capture) {
        capture.detached = true;
        this.replayCaptureBuffers.delete(sessionId);
      }
      return { ok: false, timedOut: false, error: err };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async handleWsSessionResume(
    ws: HitlWebSocket,
    frame: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const sessionId =
      typeof frame.sessionId === "string" ? frame.sessionId.trim() : "";
    if (!sessionId) {
      this.sendSessionError(ws, {
        action: "session_resume",
        code: "load_failed",
        message: "sessionId is required.",
        requestId,
      });
      return;
    }

    if (this.turnBusy || this.sessionOpInFlight) {
      this.sendSessionError(ws, {
        action: "session_resume",
        code: "turn_busy",
        message: this.turnBusy
          ? "Cannot switch sessions while a turn is running."
          : "Another session operation is currently in progress.",
        requestId,
      });
      return;
    }

    if (this.inFlightSessionLoads.has(sessionId)) {
      this.sendSessionError(ws, {
        action: "session_resume",
        code: "load_timeout",
        message: `Session '${sessionId}' still has a load in flight.`,
        requestId,
      });
      return;
    }

    const includeRecentTurns = frame.includeRecentTurns === true;
    const catalogEntry =
      this.sessionCatalog.find((s) => s.sessionId === sessionId) ??
      this.lastListing.find((s) => s.sessionId === sessionId);
    const cwd =
      typeof frame.cwd === "string" && frame.cwd.trim().length > 0
        ? expandHomeAndResolve(frame.cwd.trim(), this.defaultCwd)
        : catalogEntry?.cwd || this.defaultCwd;

    this.sessionOpInFlight = true;
    try {
      if (!(await this.isLocallyResumableAgySession(sessionId))) {
        this.sendSessionError(ws, {
          action: "session_resume",
          code: "load_failed",
          message: `Cannot resume session '${sessionId}': it is not in agy CLI's local trajectory store and may belong to Antigravity IDE.`,
          requestId,
        });
        return;
      }

      const client = await this.ensureClient();
      const supportsResume = Boolean(
        this.agentCapabilities.sessionCapabilities?.resume,
      );
      const supportsLoad = Boolean(this.agentCapabilities.loadSession);
      const isHermes = this.harness.name === "hermes";

      const mcpBindingId = this.preMintMcpBindingId();
      this.bindMcpSession(mcpBindingId, sessionId);
      const resumeParams = {
        sessionId,
        cwd,
        mcpServers: [this.buildMcpServer(mcpBindingId)],
        ...this.buildSessionInitExtensions(),
      };

      if (!isHermes && includeRecentTurns && supportsLoad) {
        const capture: ReplayCaptureBuffer = {
          turns: [],
          detached: false,
        };
        const outcome = await this.performSessionLoadWithTimeout(
          ws,
          client,
          sessionId,
          resumeParams,
          requestId,
          capture,
        );
        if (outcome.ok) {
          this.recordSessionMetadata(sessionId, outcome.result);
          this.commitActiveSessionSwitch({
            sessionId,
            cwd,
            title: capture.title ?? catalogEntry?.title ?? null,
            recentTurns: capture.turns,
            requestId,
          });
          return;
        }
        if (outcome.timedOut) {
          return;
        }

        if (!supportsResume || isSessionNotFoundError(outcome.error)) {
          this.sendSessionError(ws, {
            action: "session_resume",
            code: "load_failed",
            message: `Failed to load session '${sessionId}': ${
              outcome.error instanceof Error
                ? outcome.error.message
                : String(outcome.error)
            }`,
            requestId,
          });
          return;
        }

        this.loadingSessionIds.add(sessionId);
        let fallbackResumeRes: Record<string, unknown>;
        try {
          fallbackResumeRes = await client.sessionResume(resumeParams);
        } catch (resumeErr) {
          this.sendSessionError(ws, {
            action: "session_resume",
            code: "load_failed",
            message: `Failed to resume session '${sessionId}': ${
              resumeErr instanceof Error
                ? resumeErr.message
                : String(resumeErr)
            }`,
            requestId,
          });
          return;
        } finally {
          this.loadingSessionIds.delete(sessionId);
        }

        this.recordSessionMetadata(sessionId, fallbackResumeRes);
        this.commitActiveSessionSwitch({
          sessionId,
          cwd,
          title: capture.title ?? catalogEntry?.title ?? null,
          recentTurns: [],
          requestId,
        });
        return;
      }

      const capture: ReplayCaptureBuffer | undefined = includeRecentTurns
        ? { turns: [], detached: false }
        : undefined;
      if (supportsResume) {
        if (capture) {
          this.replayCaptureBuffers.set(sessionId, capture);
        }
        this.loadingSessionIds.add(sessionId);
        let resumeRes: Record<string, unknown>;
        try {
          resumeRes = await client.sessionResume(resumeParams);
        } finally {
          if (capture) capture.detached = true;
          this.replayCaptureBuffers.delete(sessionId);
          this.loadingSessionIds.delete(sessionId);
        }
        this.recordSessionMetadata(sessionId, resumeRes);
      } else if (supportsLoad) {
        const outcome = await this.performSessionLoadWithTimeout(
          ws,
          client,
          sessionId,
          resumeParams,
          requestId,
          capture,
        );
        if (!outcome.ok) {
          if (!outcome.timedOut) {
            this.sendSessionError(ws, {
              action: "session_resume",
              code: "load_failed",
              message: `Failed to load session '${sessionId}': ${
                outcome.error instanceof Error
                  ? outcome.error.message
                  : String(outcome.error)
              }`,
              requestId,
            });
          }
          return;
        }
        this.recordSessionMetadata(sessionId, outcome.result);
      } else {
        throw new Error(
          "Harness does not support session/resume or session/load",
        );
      }

      this.commitActiveSessionSwitch({
        sessionId,
        cwd,
        title: capture?.title ?? catalogEntry?.title ?? null,
        ...(includeRecentTurns ? { recentTurns: capture?.turns ?? [] } : {}),
        requestId,
      });
    } catch (err) {
      this.sendSessionError(ws, {
        action: "session_resume",
        code: "load_failed",
        message: `Failed to resume session '${sessionId}': ${
          err instanceof Error ? err.message : String(err)
        }`,
        requestId,
      });
    } finally {
      this.sessionOpInFlight = false;
      void this.drainQueue();
    }
  }

  private handleClientOpen(
    send: (frame: Record<string, unknown>) => boolean,
  ): void {
    for (const perm of this.pendingPermissions) {
      if (!perm.resolved) {
        send(perm.frame);
      }
    }
  }

  private recordSeenToolCall(
    sessionId: string,
    toolCallId: string,
    update: AcpSessionUpdateParams["update"],
  ): void {
    const key = `${sessionId}:${toolCallId}`;
    const existing = this.seenToolCalls.get(key) ?? { toolCallId };
    const merged: AcpPermissionToolCall = {
      ...existing,
      toolCallId,
      ...(typeof update.name === "string" && update.name.trim().length > 0
        ? { name: update.name }
        : {}),
      ...(typeof update.title === "string" && update.title.trim().length > 0
        ? { title: update.title }
        : {}),
      ...(typeof update.kind === "string" && update.kind.trim().length > 0
        ? { kind: update.kind }
        : {}),
      ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    };
    if (this.seenToolCalls.has(key)) {
      this.seenToolCalls.delete(key);
    } else if (this.seenToolCalls.size >= AcpSessionManager.MAX_SEEN_TOOL_CALLS) {
      const oldestKey = this.seenToolCalls.keys().next().value;
      if (oldestKey !== undefined) {
        this.seenToolCalls.delete(oldestKey);
      }
    }
    this.seenToolCalls.set(key, merged);
  }

  private handleAvailableCommandsUpdate(
    sessionId: string,
    rawCommands: unknown,
  ): void {
    if (!sessionId) return;
    const normalized = normalizeHostCommands(rawCommands);
    this.sessionCommandsMap.set(sessionId, normalized);
    if (sessionId === this.activeSessionId) {
      this.broadcastCommandsList(sessionId);
    }
  }

  private handleConfigOptionUpdate(
    sessionId: string,
    rawConfigOptions: unknown,
  ): void {
    if (!sessionId || !Array.isArray(rawConfigOptions)) return;
    const configOptions = rawConfigOptions as AcpConfigOption[];
    const modelOpt = findModelConfigOption(configOptions);
    const tierOpt = findTierConfigOption(configOptions);
    const state = this.sessionModelsMap.get(sessionId);

    if (state && state.selectionMethod === "set_model") {
      const baseVal =
        typeof modelOpt?.currentValue === "string"
          ? modelOpt.currentValue.trim()
          : "";
      if (!baseVal) return;
      const tierVal =
        typeof tierOpt?.currentValue === "string"
          ? tierOpt.currentValue.trim()
          : "";
      const candidates = tierVal
        ? [`${baseVal}-${tierVal}`, `${baseVal}[${tierVal}]`, baseVal]
        : [baseVal];
      const matched = candidates
        .map((cand) =>
          state.allAvailableModels.find((m) => m.modelId === cand),
        )
        .find((m): m is ChannelModelInfo => m !== undefined);

      if (!matched) {
        process.stderr.write(
          `[hitl-channel] WARN config_option_update model '${baseVal}' (tier='${tierVal}') did not match any cached availableModels for session ${sessionId}; keeping '${state.currentModelId ?? "null"}'\n`,
        );
        return;
      }

      state.currentModelId = matched.modelId;
      state.availableModels = capAvailableModels(
        state.allAvailableModels,
        matched.modelId,
      );
      if (sessionId === this.activeSessionId) {
        this.broadcastModelsState(sessionId);
      }
      return;
    }

    if (state && state.selectionMethod === "set_config_option") {
      if (!modelOpt) return;
      let candidateModels = state.allAvailableModels;
      let candidateKnownIds = state.knownModelIds;
      if (Array.isArray(modelOpt.options) && modelOpt.options.length > 0) {
        const normalized = normalizeConfigOptionModels(modelOpt.options);
        if (normalized.length > 0) {
          candidateModels = normalized;
          candidateKnownIds = new Set(normalized.map((m) => m.modelId));
        }
      }
      const nextRaw =
        typeof modelOpt.currentValue === "string"
          ? modelOpt.currentValue.trim()
          : "";
      if (nextRaw) {
        if (nextRaw.length > MAX_MODEL_ID_CHARS) {
          process.stderr.write(
            `[hitl-channel] WARN config_option_update model id exceeds max length (${nextRaw.length}) for session ${sessionId}; keeping '${state.currentModelId ?? "null"}'\n`,
          );
          return;
        }
        if (
          candidateModels.length > 0 &&
          !candidateKnownIds.has(nextRaw)
        ) {
          process.stderr.write(
            `[hitl-channel] WARN config_option_update model '${nextRaw}' not in configOptions.options for session ${sessionId}; keeping '${state.currentModelId ?? "null"}'\n`,
          );
          return;
        }
        state.currentModelId = nextRaw;
      }
      state.allAvailableModels = candidateModels;
      state.knownModelIds = candidateKnownIds;
      if (typeof modelOpt.id === "string" && modelOpt.id.trim().length > 0) {
        state.configOptionId = modelOpt.id.trim();
      }
      state.availableModels = capAvailableModels(
        state.allAvailableModels,
        state.currentModelId,
      );
      if (sessionId === this.activeSessionId) {
        this.broadcastModelsState(sessionId);
      }
      return;
    }

    if (!state && modelOpt && Array.isArray(modelOpt.options)) {
      this.recordSessionMetadata(sessionId, { configOptions });
      if (
        sessionId === this.activeSessionId &&
        this.sessionModelsMap.has(sessionId)
      ) {
        this.broadcastModelsState(sessionId);
      }
    }
  }

  private handleSessionUpdate(params: AcpSessionUpdateParams): void {
    const update = params.update;
    if (!update || typeof update !== "object") return;

    if (this.isWorkerSession(params.sessionId)) {
      if (this.loadingSessionIds.has(params.sessionId)) {
        return;
      }
      if (
        (update.sessionUpdate === "tool_call" ||
          update.sessionUpdate === "tool_call_update") &&
        typeof update.toolCallId === "string" &&
        update.toolCallId.length > 0
      ) {
        this.recordSeenToolCall(params.sessionId, update.toolCallId, update);
        return;
      }
      if (update.sessionUpdate === "agent_message_chunk") {
        const chunkText =
          typeof update.content?.text === "string" ? update.content.text : "";
        if (!chunkText) return;
        const workerTurn = this.runningTurns.get(params.sessionId);
        if (workerTurn && workerTurn.isWorker) {
          workerTurn.chunks.push(chunkText);
        }
      }
      return;
    }

    if (update.sessionUpdate === "available_commands_update") {
      this.handleAvailableCommandsUpdate(
        params.sessionId,
        update.availableCommands,
      );
      return;
    }

    if (update.sessionUpdate === "config_option_update") {
      this.handleConfigOptionUpdate(params.sessionId, update.configOptions);
      return;
    }

    if (this.loadingSessionIds.has(params.sessionId)) {
      const capture = this.replayCaptureBuffers.get(params.sessionId);
      if (capture && !capture.detached) {
        if (update.sessionUpdate === "user_message_chunk") {
          const chunkText =
            typeof update.content?.text === "string" ? update.content.text : "";
          appendCapturedTurnChunk(capture, "user", chunkText);
        } else if (update.sessionUpdate === "agent_message_chunk") {
          const chunkText =
            typeof update.content?.text === "string" ? update.content.text : "";
          appendCapturedTurnChunk(capture, "assistant", chunkText);
        } else if (
          update.sessionUpdate === "session_info_update" &&
          typeof update.title === "string"
        ) {
          capture.title = update.title;
        }
      }
      return;
    }

    if (
      (update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update") &&
      typeof update.toolCallId === "string" &&
      update.toolCallId.length > 0
    ) {
      this.recordSeenToolCall(params.sessionId, update.toolCallId, update);
      if (
        this.runningTurn &&
        this.runningTurn.sessionId === params.sessionId
      ) {
        this.handleRunningTurnToolUpdate(this.runningTurn, update);
      }
      return;
    }

    if (
      update.sessionUpdate === "session_info_update" &&
      params.sessionId === this.activeSessionId &&
      typeof update.title === "string"
    ) {
      this.activeSessionTitle = update.title;
      const catEntry = this.sessionCatalog.find(
        (s) => s.sessionId === params.sessionId,
      );
      if (catEntry) {
        catEntry.title = update.title;
      }
      return;
    }

    if (update.sessionUpdate === "agent_message_chunk") {
      const chunkText =
        typeof update.content?.text === "string" ? update.content.text : "";
      if (!chunkText) return;

      if (
        this.runningTurn &&
        this.runningTurn.sessionId === params.sessionId
      ) {
        this.runningTurn.chunks.push(chunkText);
        this.queueStreamDelta(this.runningTurn, chunkText);
      } else {
        if (
          this.outOfTurnSessionId &&
          this.outOfTurnSessionId !== params.sessionId &&
          this.outOfTurnChunks.length > 0
        ) {
          this.flushOutOfTurnBuffer();
        }
        this.outOfTurnSessionId = params.sessionId;
        this.outOfTurnChunks.push(chunkText);
        this.resetOutOfTurnTimer();
      }
    }
  }

  private resetOutOfTurnTimer(): void {
    if (this.outOfTurnTimer) {
      clearTimeout(this.outOfTurnTimer);
    }
    this.outOfTurnTimer = setTimeout(() => {
      this.outOfTurnTimer = null;
      this.flushOutOfTurnBuffer();
    }, this.outOfTurnQuietMs);
  }

  flushOutOfTurnBuffer(): void {
    if (this.outOfTurnTimer) {
      clearTimeout(this.outOfTurnTimer);
      this.outOfTurnTimer = null;
    }
    if (this.outOfTurnChunks.length === 0) {
      this.outOfTurnSessionId = null;
      return;
    }
    const text = this.outOfTurnChunks.join("");
    const sessionId = this.outOfTurnSessionId ?? this.activeSessionId;
    this.outOfTurnChunks = [];
    this.outOfTurnSessionId = null;
    if (text.length > 0) {
      this.sendStandaloneReply(text, sessionId);
    }
  }

  private handlePermissionRequest(
    client: AcpClient,
    rpcId: string | number,
    params: AcpPermissionRequestParams,
  ): void {
    const toolCall = params.toolCall ?? {};
    const options = Array.isArray(params.options) ? params.options : [];
    const sessionId = params.sessionId ?? this.activeSessionId ?? "";
    const toolCallId =
      typeof toolCall.toolCallId === "string" && toolCall.toolCallId.length > 0
        ? toolCall.toolCallId
        : undefined;
    const correlated =
      toolCallId && sessionId
        ? this.seenToolCalls.get(`${sessionId}:${toolCallId}`)
        : undefined;
    const toolName = deriveToolName(toolCall, correlated);
    const rawInputForHash =
      toolCall.rawInput !== undefined
        ? toolCall.rawInput
        : correlated?.rawInput ?? null;
    const promptHash = sha256Hex(stableStringify(rawInputForHash));

    if (
      isOwnHitlTool(toolCall, this.harness.autoAllowPrefixes, {
        matchBareTitlePrefix: this.harness.matchBareTitlePrefix,
        correlatedToolCall: correlated,
      })
    ) {
      const allowOpt =
        options.find((o) => o.kind === "allow_once") ??
        options.find((o) => o.kind?.startsWith("allow")) ??
        options.find((o) => o.optionId === "allow");
      if (allowOpt) {
        client.respond(rpcId, {
          outcome: { outcome: "selected", optionId: allowOpt.optionId },
        });
        this.emitPermissionAudit(toolName, "auto", promptHash, sessionId || null);
        return;
      }
      // Fail closed: if no explicit allow option exists, fall through to phone prompt.
    }

    const prompt = formatPermissionPrompt(toolCall, correlated);
    const frameId = `perm-${Date.now()}-${++this.permSeq}-${Math.random().toString(36).slice(2, 6)}`;

    if (sessionId && this.isWorkerSession(sessionId)) {
      const workerCtx = this.workerContextBySessionId.get(sessionId);
      const pending: PendingPermission = {
        rpcId,
        client,
        sessionId,
        acpSessionId: sessionId,
        toolName,
        promptHash,
        frame: { id: frameId },
        options,
        resolved: false,
        isWorker: true,
        workerRunId: workerCtx?.runId,
        choicesId: frameId,
      };
      const list = this.pendingPermissionsBySession.get(sessionId) ?? [];
      list.push(pending);
      this.pendingPermissionsBySession.set(sessionId, list);

      if (workerCtx) {
        this.emitWorkerEvent({
          type: "host_run_event",
          event_id: globalThis.crypto.randomUUID(),
          run_id: workerCtx.runId,
          acp_session_id: sessionId,
          kind: "permission_request",
          pinned: true,
          choices_id: frameId,
          tool_name: toolName,
          prompt,
          options: options.map((o) => ({
            optionId: o.optionId,
            name: o.name,
            kind: o.kind,
          })),
          ts: new Date(this.nowMs()).toISOString(),
        });
      }
      return;
    }

    const choices = options.map((o) => o.name || o.optionId);
    const acpSessionId = sessionId || this.activeSessionId || null;
    const activeTurnId =
      this.runningTurn &&
      (!sessionId || this.runningTurn.sessionId === sessionId)
        ? this.runningTurn.turnId
        : null;
    const frame: Record<string, unknown> = {
      type: "choices",
      category: "permission",
      toolName,
      ...(acpSessionId ? { acpSessionId } : {}),
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      options: options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      })),
      content: prompt,
      choices,
      multiSelect: false,
      id: frameId,
      ts: new Date(this.nowMs()).toISOString(),
    };

    const pending: PendingPermission = {
      rpcId,
      client,
      sessionId,
      acpSessionId,
      toolName,
      promptHash,
      frame,
      options,
      resolved: false,
      isWorker: false,
    };
    this.pendingPermissions.push(pending);
    if (sessionId) {
      const list = this.pendingPermissionsBySession.get(sessionId) ?? [];
      list.push(pending);
      this.pendingPermissionsBySession.set(sessionId, list);
    }
    this.unicastFrameFn(frame);
    this.emitTurnState({
      sessionId: acpSessionId,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      state: "waiting_approval",
    });
  }

  private cancelWorkerPendingPermissions(
    sessionId: string,
    respondToClient: boolean,
  ): void {
    const list = this.pendingPermissionsBySession.get(sessionId);
    if (!list || list.length === 0) return;
    while (list.length > 0) {
      const perm = list.shift()!;
      if (perm.resolved) continue;
      perm.resolved = true;
      if (respondToClient && !perm.client.isClosed) {
        perm.client.respond(perm.rpcId, { outcome: { outcome: "cancelled" } });
      }
      if (perm.choicesId) {
        this.workerOutbox.unpinByChoicesId(perm.choicesId);
        this.pendingWorkerMcpChoices.delete(perm.choicesId);
      }
      this.emitPermissionAudit(
        perm.toolName,
        "cancelled",
        perm.promptHash,
        sessionId,
      );
    }
    this.pendingPermissionsBySession.delete(sessionId);
  }

  private cancelAllPendingPermissions(respondToClient: boolean): number {
    let count = 0;
    const cancelledBySession = new Map<string, string[]>();
    while (this.pendingPermissions.length > 0) {
      const perm = this.pendingPermissions.shift()!;
      if (perm.resolved) continue;
      perm.resolved = true;
      count++;
      if (respondToClient && this.client && !this.client.isClosed) {
        this.client.respond(perm.rpcId, { outcome: { outcome: "cancelled" } });
      }
      const resolvedSession =
        perm.acpSessionId ?? (perm.sessionId || this.activeSessionId || null);
      this.emitPermissionAudit(
        perm.toolName,
        "cancelled",
        perm.promptHash,
        resolvedSession,
      );
      const frameId = typeof perm.frame.id === "string" ? perm.frame.id : "";
      if (frameId) {
        const key = resolvedSession ?? "";
        let list = cancelledBySession.get(key);
        if (!list) {
          list = [];
          cancelledBySession.set(key, list);
        }
        list.push(frameId);
      }
      if (perm.sessionId) {
        const sessPerms = this.pendingPermissionsBySession.get(perm.sessionId);
        if (sessPerms) {
          const idx = sessPerms.indexOf(perm);
          if (idx !== -1) sessPerms.splice(idx, 1);
          if (sessPerms.length === 0) {
            this.pendingPermissionsBySession.delete(perm.sessionId);
          }
        }
      }
    }
    for (const [sessionKey, frameIds] of cancelledBySession.entries()) {
      this.emitChoicesSettled({
        frameIds,
        acpSessionId: sessionKey || null,
        reason: "cancelled",
      });
    }
    return count;
  }

  private settleWorkersForExitedClient(
    exitedClient: AcpClient,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const exitDetail =
      signal !== null
        ? `code=${code ?? "null"}, signal=${signal}`
        : `code=${code ?? "null"}`;
    const hostedSessionIds: string[] = [];
    for (const [sid, entry] of this.workerSessions.entries()) {
      if (entry.client === exitedClient) {
        hostedSessionIds.push(sid);
      }
    }

    for (const sid of hostedSessionIds) {
      this.cancelWorkerPendingPermissions(sid, false);
      const turn = this.runningTurns.get(sid);
      if (turn) {
        this.runningTurns.delete(sid);
      }
      this.sessionQueues.delete(sid);
      const ctx = this.workerContextBySessionId.get(sid);
      const runState = ctx ? this.workerRunsById.get(ctx.runId) : undefined;
      if (runState && !runState.terminalEmitted) {
        runState.terminalEmitted = true;
        this.emitWorkerEvent({
          type: "host_run_event",
          event_id: globalThis.crypto.randomUUID(),
          run_id: runState.runId,
          acp_session_id: sid,
          kind: "failed",
          pinned: true,
          reason: "harness_exited",
          error: `Harness ${this.harness.name} exited unexpectedly (${exitDetail})`,
          ts: new Date(this.nowMs()).toISOString(),
        });
      }
      const entry = this.workerSessions.get(sid);
      if (entry) {
        entry.activeRunId = null;
      }
      this.workerSessions.delete(sid);
      this.workerContextBySessionId.delete(sid);
      this.evictedWorkerSessionIds.add(sid);
    }
  }

  private handleHarnessExit(
    exitedClient: AcpClient,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const workerProcIdx = this.workerProcesses.findIndex(
      (p) => p.client === exitedClient,
    );
    if (workerProcIdx !== -1) {
      this.workerProcesses.splice(workerProcIdx, 1);
      while (this.workerProcessWaiters.length > 0) {
        this.workerProcessWaiters.shift()?.();
      }
      if (!this.shuttingDown) {
        this.settleWorkersForExitedClient(exitedClient, code, signal);
      }
      return;
    }

    if (this.client === exitedClient) {
      this.client = null;
    }
    if (this.shuttingDown) return;

    this.settleWorkersForExitedClient(exitedClient, code, signal);

    const abortedTurn = this.runningTurn;
    if (abortedTurn) {
      this.flushPendingTurnDelta(abortedTurn);
      this.clearTurnDeltaTimer(abortedTurn);
      this.runningTurns.delete(abortedTurn.sessionId);
    }

    this.cancelAllPendingPermissions(false);
    this.flushOutOfTurnBuffer();

    const prevSessionId = this.activeSessionId;
    this.runningTurn = null;
    this.turnBusy = false;
    this.activeSessionId = null;
    this.activeSessionCwd = null;
    this.activeSessionTitle = null;
    this.catalogMutationSeq++;
    this.openUserChoiceIds.clear();
    this.replayCaptureBuffers.clear();
    this.inFlightSessionLoads.clear();
    this.loadingSessionIds.clear();
    this.seenToolCalls.clear();
    this.instructionsDeliveredSessions.clear();
    this.sessionModelsMap.clear();
    this.sessionCommandsMap.clear();

    if (prevSessionId !== null) {
      this.broadcastSessionChange();
    }

    const now = this.nowMs();
    this.crashTimestamps = this.crashTimestamps.filter(
      (ts) => now - ts < this.crashWindowMs,
    );
    this.crashTimestamps.push(now);

    const exitDetail =
      signal !== null ? `code=${code ?? "null"}, signal=${signal}` : `code=${code ?? "null"}`;

    if (this.crashTimestamps.length >= 2) {
      this.restartStopped = true;
      this.queue.length = 0;
      this.sendStandaloneReply(
        `⚠ Harness ${this.harness.name} crashed repeatedly (${exitDetail}) within 60s; automatic restart stopped.`,
        prevSessionId,
      );
      this.emitTurnState({
        sessionId: this.activeSessionId,
        ...(abortedTurn ? { turnId: abortedTurn.turnId } : {}),
        state: "idle",
        finalReplyId: null,
      });
      return;
    }

    this.sendStandaloneReply(
      `⚠ Harness ${this.harness.name} exited unexpectedly (${exitDetail}). Restarting automatically — use /sessions and /resume to continue.`,
      prevSessionId,
    );
    this.emitTurnState({
      sessionId: this.activeSessionId,
      ...(abortedTurn ? { turnId: abortedTurn.turnId } : {}),
      state: "idle",
      finalReplyId: null,
    });

    void this.ensureClient()
      .then(() => {
        if (this.queue.length > 0 && !this.turnBusy) {
          void this.drainQueue();
        }
      })
      .catch((err) => {
        process.stderr.write(
          `[hitl-channel] automatic harness restart failed: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      });
  }

  private parseRecognisedSlashCommand(
    text: string,
  ): { name: string; argsText: string } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;
    const match = trimmed.match(/^(\/[a-zA-Z]+)(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    const cmd = match[1]!;
    const known = ["/help", "/new", "/sessions", "/resume", "/cancel", "/status"];
    if (!known.includes(cmd)) return null;
    return { name: cmd, argsText: (match[2] ?? "").trim() };
  }

  private matchPermissionOption(
    perm: PendingPermission,
    input: InboundMessage,
  ): AcpPermissionOption | null {
    const rawOptionId =
      typeof input.meta.option_id === "string"
        ? input.meta.option_id.trim()
        : "";
    if (rawOptionId.length > 0) {
      const exact = perm.options.find((opt) => opt.optionId === rawOptionId);
      if (exact) return exact;
      const ci = perm.options.find(
        (opt) => opt.optionId.toLowerCase() === rawOptionId.toLowerCase(),
      );
      if (ci) return ci;
    }

    const candidates: string[] = [];
    const trimmed = input.text.trim();
    if (trimmed) candidates.push(trimmed.toLowerCase());
    if (Array.isArray(input.meta.selections)) {
      for (const s of input.meta.selections) {
        if (typeof s === "string" && s.trim()) {
          candidates.push(s.trim().toLowerCase());
        }
      }
    }
    for (const candidate of candidates) {
      const hit = perm.options.find(
        (opt) =>
          opt.name.toLowerCase() === candidate ||
          opt.optionId.toLowerCase() === candidate,
      );
      if (hit) return hit;
    }
    return null;
  }

  private resolvePendingPermission(
    index: number,
    perm: PendingPermission,
    matchedOpt: AcpPermissionOption,
  ): string | null {
    this.pendingPermissions.splice(index, 1);
    if (perm.sessionId) {
      const sessPerms = this.pendingPermissionsBySession.get(perm.sessionId);
      if (sessPerms) {
        const idx = sessPerms.indexOf(perm);
        if (idx !== -1) sessPerms.splice(idx, 1);
        if (sessPerms.length === 0) {
          this.pendingPermissionsBySession.delete(perm.sessionId);
        }
      }
    }
    perm.resolved = true;
    if (this.client && !this.client.isClosed) {
      this.client.respond(perm.rpcId, {
        outcome: { outcome: "selected", optionId: matchedOpt.optionId },
      });
    }
    const approval = matchedOpt.kind.startsWith("reject")
      ? "user_denied"
      : "user_approved";
    const permSessionId =
      perm.acpSessionId ?? (perm.sessionId || this.activeSessionId);
    this.emitPermissionAudit(
      perm.toolName,
      approval,
      perm.promptHash,
      permSessionId,
    );
    this.emitChoicesSettled({
      frameIds: [String(perm.frame.id)],
      acpSessionId: permSessionId,
      reason: "answered",
      selectedLabel: matchedOpt.name || matchedOpt.optionId,
    });
    if (this.pendingPermissions.length === 0) {
      if (this.runningTurn && !this.runningTurn.cancelledByCommand) {
        this.emitTurnState({
          sessionId: this.runningTurn.sessionId,
          turnId: this.runningTurn.turnId,
          state: "running",
        });
      } else if (!this.runningTurn && !this.turnBusy && !this.sessionOpInFlight) {
        this.emitTurnState({
          sessionId: permSessionId ?? this.activeSessionId,
          state: "idle",
          finalReplyId: null,
        });
      }
    }
    if (
      !this.turnBusy &&
      !this.sessionOpInFlight &&
      this.pendingPermissions.length === 0
    ) {
      void this.drainQueue();
    }
    return permSessionId;
  }

  /**
   * Normative inbound routing order (SPEC-HC-005 §4.1 + SPEC-HITL-APP-10827 AV7):
   * 1. Pairing is handled outside via `onPairingCode`.
   * 2. Recognised slash command.
   * 3. Pending permission (exact `choices_id` when present, else FIFO `[0]`).
   * 4. `choice_response` matching `openUserChoiceIds` (exact or oldest fallback).
   * 5. Turn running / session op / pending permission -> FIFO queue.
   * 6. Dispatch as `session/prompt` (auto-creating a session if none exists).
   */
  async handleInbound(
    input: InboundMessage,
  ): Promise<{ acpSessionId?: string | null }> {
    const metaType =
      typeof input.meta.type === "string" ? input.meta.type : undefined;
    const isChoiceResponse = metaType === "choice_response";
    const isQuestionsBatchResponse = metaType === "questions_batch_response";
    const choicesId =
      typeof input.meta.choices_id === "string" &&
      input.meta.choices_id.trim().length > 0
        ? input.meta.choices_id.trim()
        : undefined;

    // Step 2: Slash commands (plain text only)
    if (!isChoiceResponse && !isQuestionsBatchResponse) {
      const cmd = this.parseRecognisedSlashCommand(input.text);
      if (cmd) {
        return this.handleSlashCommand(cmd.name, cmd.argsText);
      }
    }

    // Step 3a: Exact choices_id correlation when supplied on choice_response
    if (isChoiceResponse && choicesId !== undefined) {
      const permIdx = this.pendingPermissions.findIndex(
        (p) => !p.resolved && p.frame.id === choicesId,
      );
      if (permIdx !== -1) {
        const perm = this.pendingPermissions[permIdx]!;
        const matchedOpt = this.matchPermissionOption(perm, input);
        if (matchedOpt) {
          return {
            acpSessionId: this.resolvePendingPermission(
              permIdx,
              perm,
              matchedOpt,
            ),
          };
        }

        const validLabels = perm.options.map((o) => o.name).join(", ");
        const permSessionId =
          perm.acpSessionId ?? (perm.sessionId || this.activeSessionId);
        this.sendStandaloneReply(
          `no matching approval option (expected: ${validLabels})`,
          permSessionId,
        );
        return { acpSessionId: permSessionId };
      }

      if (this.openUserChoiceIds.has(choicesId)) {
        this.openUserChoiceIds.delete(choicesId);
        // Fall through past Step 3 to Steps 5/6
      } else {
        this.sendStandaloneReply(
          "approval expired or already resolved",
          this.activeSessionId,
        );
        return { acpSessionId: this.activeSessionId };
      }
    } else {
      // Step 3b: Pending permission on active session (legacy omit-choices_id FIFO)
      if (this.pendingPermissions.length > 0) {
        const oldest = this.pendingPermissions[0]!;
        const matchedOpt = this.matchPermissionOption(oldest, input);
        if (matchedOpt && !oldest.resolved) {
          return {
            acpSessionId: this.resolvePendingPermission(0, oldest, matchedOpt),
          };
        }

        if (isChoiceResponse) {
          const validLabels = oldest.options.map((o) => o.name).join(", ");
          this.sendStandaloneReply(
            `no matching approval option (expected: ${validLabels})`,
            this.activeSessionId,
          );
          return { acpSessionId: this.activeSessionId };
        }

        this.queue.push({ input, isChoiceResponse: false });
        this.sendStandaloneReply(
          "⚠ waiting for your approval above (queued)",
          this.activeSessionId,
        );
        this.emitTurnState();
        return { acpSessionId: this.activeSessionId };
      }

      // Step 4: `choice_response` with no pending permission (legacy fallback)
      if (isChoiceResponse) {
        if (this.openUserChoiceIds.size > 0) {
          const oldestChoiceId = this.openUserChoiceIds.values().next().value;
          if (oldestChoiceId !== undefined) {
            this.openUserChoiceIds.delete(oldestChoiceId);
          }
        } else {
          this.sendStandaloneReply("no pending approval", this.activeSessionId);
          return { acpSessionId: this.activeSessionId };
        }
      }
    }

    // Step 5: Turn running, session switch in flight, or pending permission? Queue FIFO
    if (
      this.turnBusy ||
      this.sessionOpInFlight ||
      this.pendingPermissions.length > 0
    ) {
      this.queue.push({ input, isChoiceResponse });
      this.sendStandaloneReply(
        `⏳ queued (${this.queue.length} ahead)`,
        this.activeSessionId,
        undefined,
        { excludeFeature: "streaming" },
      );
      this.emitTurnState();
      return { acpSessionId: this.activeSessionId };
    }

    // Step 6: Start prompt turn
    return this.startTurn({ input, isChoiceResponse });
  }

  /** Reject `/new` or `/resume` with a distinct reply when a turn or session switch is active. */
  private rejectIfBusyForSessionSwitch(): boolean {
    if (this.turnBusy) {
      this.sendStandaloneReply(
        "⚠ A turn is currently running — send /cancel first",
        this.activeSessionId,
      );
      return true;
    }
    if (this.sessionOpInFlight) {
      this.sendStandaloneReply(
        "⚠ A session switch is currently in progress — please wait",
        this.activeSessionId,
      );
      return true;
    }
    return false;
  }

  private cancelActiveTurn(opts: {
    notifyWhenIdle: boolean;
    sessionIdFilter?: string;
  }): { acpSessionId: string | null } {
    const currentSessionId =
      this.runningTurn?.sessionId ?? this.activeSessionId;
    if (
      opts.sessionIdFilter &&
      opts.sessionIdFilter !== currentSessionId
    ) {
      return { acpSessionId: this.activeSessionId };
    }

    if (this.runningTurn && this.client && !this.client.isClosed) {
      this.runningTurn.cancelledByCommand = true;
      this.cancelAllPendingPermissions(true);
      this.client.sessionCancel(this.runningTurn.sessionId);
      return { acpSessionId: this.runningTurn.sessionId };
    }

    const cancelledPerms = this.cancelAllPendingPermissions(true);
    if (this.turnBusy) {
      this.cancelRequestedBeforeTurn = true;
      return { acpSessionId: this.activeSessionId };
    }

    if (cancelledPerms > 0) {
      this.sendStandaloneReply("⏹ cancelled", this.activeSessionId);
      this.emitTurnState({
        sessionId: this.activeSessionId,
        state: "idle",
        finalReplyId: null,
      });
    } else if (opts.notifyWhenIdle) {
      this.sendStandaloneReply("nothing running", this.activeSessionId);
    }
    return { acpSessionId: this.activeSessionId };
  }

  private async handleSlashCommand(
    cmd: string,
    argsText: string,
  ): Promise<{ acpSessionId?: string | null }> {
    if (cmd === "/help") {
      const helpText = [
        "Available commands:",
        "- /help — show this command list",
        `- /new [harness] [cwd] — start a new session (this daemon runs harness: ${this.harness.name})`,
        "- /sessions — list recent sessions",
        "- /resume <n|id> — switch to and resume a session",
        "- /cancel — cancel pending approvals and stop the running turn",
        "- /status — show harness, active session, turn, queue, and approvals",
      ].join("\n");
      this.sendStandaloneReply(helpText, this.activeSessionId);
      return { acpSessionId: this.activeSessionId };
    }

    if (cmd === "/status") {
      const sessionSummary = this.activeSessionId
        ? `${this.activeSessionTitle ?? "(untitled)"} (${this.activeSessionId}) · ${this.activeSessionCwd ?? this.defaultCwd}`
        : "(none)";
      const statusText = [
        `Harness: ${this.harness.name}`,
        `Session: ${sessionSummary}`,
        `Turn running: ${this.turnBusy ? "yes" : "no"}`,
        `Queue depth: ${this.queue.length}`,
        `Pending approvals: ${this.pendingPermissions.length}`,
      ].join("\n");
      this.sendStandaloneReply(statusText, this.activeSessionId);
      return { acpSessionId: this.activeSessionId };
    }

    if (cmd === "/cancel") {
      return this.cancelActiveTurn({ notifyWhenIdle: true });
    }

    if (cmd === "/new") {
      if (this.rejectIfBusyForSessionSwitch()) {
        return { acpSessionId: this.activeSessionId };
      }
      const tokens = argsText ? argsText.split(/\s+/) : [];
      let targetHarness = this.harness.name;
      let rawCwd = this.defaultCwd;

      if (tokens.length === 1) {
        const tok = tokens[0]!;
        if (tok.startsWith("/") || tok.startsWith("~") || tok.startsWith(".")) {
          rawCwd = tok;
        } else {
          targetHarness = tok;
        }
      } else if (tokens.length >= 2) {
        targetHarness = tokens[0]!;
        rawCwd = tokens.slice(1).join(" ");
      }

      if (targetHarness !== this.harness.name) {
        this.sendStandaloneReply(
          `Unsupported harness '${targetHarness}' on this '${this.harness.name}' daemon. Run a separate daemon with --harness ${targetHarness}.`,
          this.activeSessionId,
        );
        return { acpSessionId: this.activeSessionId };
      }

      const absCwd = expandHomeAndResolve(rawCwd, this.defaultCwd);
      this.sessionOpInFlight = true;
      try {
        try {
          const st = await stat(absCwd);
          if (!st.isDirectory()) {
            this.sendStandaloneReply(
              `Not a directory: ${absCwd}`,
              this.activeSessionId,
            );
            return { acpSessionId: this.activeSessionId };
          }
        } catch {
          this.sendStandaloneReply(
            `Directory does not exist: ${absCwd}`,
            this.activeSessionId,
          );
          return { acpSessionId: this.activeSessionId };
        }

        const client = await this.ensureClient();
        this.flushOutOfTurnBuffer();
        const mcpBindingId = this.preMintMcpBindingId();
        const res = await client.sessionNew({
          cwd: absCwd,
          mcpServers: [this.buildMcpServer(mcpBindingId)],
          ...this.buildSessionInitExtensions(),
        });
        this.bindMcpSession(mcpBindingId, res.sessionId);
        this.createdSessionIds.add(res.sessionId);
        this.activeSessionId = res.sessionId;
        this.activeSessionCwd = absCwd;
        this.activeSessionTitle = null;
        this.openUserChoiceIds.clear();
        this.touchRecentCwd(absCwd);
        this.upsertCatalogSession({
          sessionId: res.sessionId,
          cwd: absCwd,
          updatedAt: new Date(this.nowMs()).toISOString(),
        });
        this.recordSessionMetadata(res.sessionId, res);
        this.broadcastSessionChange();
        this.sendStandaloneReply(
          `▶ New ${this.harness.name} session in \`${absCwd}\` (id ${res.sessionId})`,
          res.sessionId,
        );
        return { acpSessionId: res.sessionId };
      } catch (err) {
        this.sendStandaloneReply(
          `Failed to create session: ${err instanceof Error ? err.message : err}`,
          this.activeSessionId,
        );
        return { acpSessionId: this.activeSessionId };
      } finally {
        this.sessionOpInFlight = false;
        void this.drainQueue();
      }
    }

    if (cmd === "/sessions") {
      try {
        const client = await this.ensureClient();
        const res = await client.sessionList({});
        const filtered = await this.filterResumableSessions(res.sessions ?? []);
        const sorted = this.updateCatalogFromList(filtered);

        const top = sorted.slice(0, 10);
        if (
          this.activeSessionId &&
          !top.some((s) => s.sessionId === this.activeSessionId)
        ) {
          const activeEntry = sorted.find(
            (s) => s.sessionId === this.activeSessionId,
          ) ?? {
            sessionId: this.activeSessionId,
            title: this.activeSessionTitle ?? "(active)",
            cwd: this.activeSessionCwd ?? this.defaultCwd,
          };
          top.push(activeEntry);
        }

        this.lastListing = top;
        if (top.length === 0) {
          this.sendStandaloneReply("No sessions found.", this.activeSessionId);
          return { acpSessionId: this.activeSessionId };
        }

        const now = this.nowMs();
        const lines = top.map((s, idx) => {
          const num = idx + 1;
          const title = s.title?.trim() || "(untitled)";
          const cwd = s.cwd || "?";
          const rel = formatRelativeTime(s.updatedAt, now);
          const activeMark = s.sessionId === this.activeSessionId ? " [active]" : "";
          return `${num}. ${title} · ${cwd} · ${rel}${activeMark}`;
        });
        this.sendStandaloneReply(lines.join("\n"), this.activeSessionId);
        return { acpSessionId: this.activeSessionId };
      } catch (err) {
        this.sendStandaloneReply(
          `Failed to list sessions: ${err instanceof Error ? err.message : err}`,
          this.activeSessionId,
        );
        return { acpSessionId: this.activeSessionId };
      }
    }

    if (cmd === "/resume") {
      if (this.rejectIfBusyForSessionSwitch()) {
        return { acpSessionId: this.activeSessionId };
      }
      const target = argsText.split(/\s+/)[0]?.trim();
      if (!target) {
        this.sendStandaloneReply(
          "Usage: /resume <number|session-id>",
          this.activeSessionId,
        );
        return { acpSessionId: this.activeSessionId };
      }

      let resolved: AcpSessionInfo | undefined;
      if (/^\d+$/.test(target)) {
        const index = Number(target) - 1;
        if (index < 0 || index >= this.lastListing.length) {
          this.sendStandaloneReply(
            `Session #${target} not found in last /sessions listing.`,
            this.activeSessionId,
          );
          return { acpSessionId: this.activeSessionId };
        }
        resolved = this.lastListing[index]!;
      } else {
        resolved = this.lastListing.find((s) => s.sessionId === target);
      }

      this.sessionOpInFlight = true;
      try {
        const client = await this.ensureClient();
        if (!resolved) {
          const listRes = await client.sessionList({});
          const filtered = await this.filterResumableSessions(
            listRes.sessions ?? [],
          );
          resolved = filtered.find((s) => s.sessionId === target);
        }

        const sessionId = resolved?.sessionId ?? target;
        if (!(await this.isLocallyResumableAgySession(sessionId))) {
          this.sendStandaloneReply(
            `Failed to resume session: '${sessionId}' is not in agy CLI's local store (it may belong to Antigravity IDE).`,
            this.activeSessionId,
          );
          return { acpSessionId: this.activeSessionId };
        }
        if (this.inFlightSessionLoads.has(sessionId)) {
          this.sendStandaloneReply(
            `Failed to resume session: '${sessionId}' still has a load in flight.`,
            this.activeSessionId,
          );
          return { acpSessionId: this.activeSessionId };
        }
        const cwd = resolved?.cwd || this.defaultCwd;
        const title = resolved?.title?.trim() || sessionId;

        this.flushOutOfTurnBuffer();
        const supportsResume = Boolean(
          this.agentCapabilities.sessionCapabilities?.resume,
        );
        const mcpBindingId = this.preMintMcpBindingId();
        this.bindMcpSession(mcpBindingId, sessionId);
        const resumeParams = {
          sessionId,
          cwd,
          mcpServers: [this.buildMcpServer(mcpBindingId)],
          ...this.buildSessionInitExtensions(),
        };
        // Suppress history replay notifications emitted synchronously during both
        // session/load and session/resume (Hermes streams replay inside resume_session).
        this.loadingSessionIds.add(sessionId);
        let resumeOrLoadRes: Record<string, unknown>;
        try {
          if (supportsResume) {
            resumeOrLoadRes = await client.sessionResume(resumeParams);
          } else {
            resumeOrLoadRes = await client.sessionLoad(resumeParams);
          }
        } finally {
          this.loadingSessionIds.delete(sessionId);
        }

        this.activeSessionId = sessionId;
        this.activeSessionCwd = cwd;
        this.activeSessionTitle = resolved?.title ?? null;
        this.openUserChoiceIds.clear();
        this.touchRecentCwd(cwd);
        this.upsertCatalogSession({
          sessionId,
          cwd,
          ...(resolved?.title ? { title: resolved.title } : {}),
          updatedAt: new Date(this.nowMs()).toISOString(),
        });
        this.recordSessionMetadata(sessionId, resumeOrLoadRes);
        this.broadcastSessionChange();
        this.sendStandaloneReply(`▶ Resumed \`${title}\``, sessionId);
        return { acpSessionId: sessionId };
      } catch (err) {
        this.sendStandaloneReply(
          `Failed to resume session: ${err instanceof Error ? err.message : err}`,
          this.activeSessionId,
        );
        return { acpSessionId: this.activeSessionId };
      } finally {
        this.sessionOpInFlight = false;
        void this.drainQueue();
      }
    }

    return { acpSessionId: this.activeSessionId };
  }

  private async startTurn(item: QueuedTurn): Promise<{ acpSessionId?: string | null }> {
    this.turnBusy = true;
    this.cancelRequestedBeforeTurn = false;
    if (!item.isChoiceResponse) {
      this.openUserChoiceIds.clear();
    }
    let client: AcpClient;
    let sessionId: string;

    try {
      client = await this.ensureClient();
      if (!this.activeSessionId) {
        const mcpBindingId = this.preMintMcpBindingId();
        const res = await client.sessionNew({
          cwd: this.defaultCwd,
          mcpServers: [this.buildMcpServer(mcpBindingId)],
          ...this.buildSessionInitExtensions(),
        });
        this.bindMcpSession(mcpBindingId, res.sessionId);
        this.createdSessionIds.add(res.sessionId);
        this.activeSessionId = res.sessionId;
        this.activeSessionCwd = this.defaultCwd;
        this.activeSessionTitle = null;
        this.openUserChoiceIds.clear();
        this.touchRecentCwd(this.defaultCwd);
        this.upsertCatalogSession({
          sessionId: res.sessionId,
          cwd: this.defaultCwd,
          updatedAt: new Date(this.nowMs()).toISOString(),
        });
        this.recordSessionMetadata(res.sessionId, res);
        this.broadcastSessionChange();
        this.sendStandaloneReply(
          `▶ Auto-created ${this.harness.name} session in \`${this.defaultCwd}\` (id ${res.sessionId})`,
          res.sessionId,
        );
      }
      sessionId = this.activeSessionId;
      const pendingLoad = this.inFlightSessionLoads.get(sessionId);
      if (pendingLoad) {
        await pendingLoad.catch(() => {});
        if (this.shuttingDown || client.isClosed || this.activeSessionId !== sessionId) {
          this.turnBusy = false;
          this.cancelRequestedBeforeTurn = false;
          if (!this.shuttingDown && !client.isClosed) {
            this.emitTurnState({
              sessionId: this.activeSessionId,
              state: "idle",
              finalReplyId: null,
            });
          }
          return { acpSessionId: this.activeSessionId };
        }
      }
    } catch (err) {
      this.turnBusy = false;
      this.cancelRequestedBeforeTurn = false;
      this.sendStandaloneReply(
        `Failed to start ${this.harness.name} session: ${
          err instanceof Error ? err.message : err
        }`,
        this.activeSessionId,
      );
      this.emitTurnState({
        sessionId: this.activeSessionId,
        state: "idle",
        finalReplyId: null,
      });
      void this.drainQueue();
      return { acpSessionId: this.activeSessionId };
    }

    this.flushOutOfTurnBuffer();

    const delegationMessageId = extractWorkflowDelegationMessageId(item.input.text);
    const clientMessageId =
      typeof item.input.meta.client_message_id === "string" &&
      item.input.meta.client_message_id.length > 0
        ? item.input.meta.client_message_id
        : null;

    const turn: RunningTurn = {
      turnId: `turn-${this.nowMs()}-${++this.turnSeq}`,
      sessionId,
      chunks: [],
      delegationMessageId,
      clientMessageId,
      replyToolCalled: false,
      cancelledByCommand: this.cancelRequestedBeforeTurn,
      deltaSeq: 0,
      pendingDeltaText: "",
      deltaTimer: null,
      emittedDeltaBytes: 0,
      deltaTruncated: false,
      toolSteps: new Map(),
    };
    this.cancelRequestedBeforeTurn = false;
    this.runningTurn = turn;
    this.runningTurns.set(sessionId, turn);

    if (turn.cancelledByCommand) {
      this.runningTurn = null;
      this.runningTurns.delete(sessionId);
      this.turnBusy = false;
      const targetMsgId = turn.delegationMessageId ?? turn.clientMessageId ?? undefined;
      const finalReplyId = this.sendStandaloneReply(
        "⏹ cancelled",
        sessionId,
        targetMsgId,
        { turnId: turn.turnId, isTurnFinal: true },
      );
      this.emitTurnState({
        sessionId,
        turnId: turn.turnId,
        state: "idle",
        finalReplyId,
      });
      void this.drainQueue();
      return { acpSessionId: sessionId };
    }

    this.emitTurnState({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      state: "running",
    });
    void this.executeTurn(client, turn, item.input);
    return { acpSessionId: sessionId };
  }

  private async executeTurn(
    client: AcpClient,
    turn: RunningTurn,
    input: InboundMessage,
  ): Promise<void> {
    let finalReplyId: string | null = null;
    try {
      let promptBlocks = await this.buildPromptBlocks(input);
      if (client.isClosed || this.shuttingDown || this.runningTurn !== turn) {
        return;
      }
      if (turn.cancelledByCommand) {
        this.flushPendingTurnDelta(turn);
        const finalizedToolSteps = this.finalizeToolSteps(turn, true);
        const targetMsgId =
          turn.delegationMessageId ?? turn.clientMessageId ?? undefined;
        finalReplyId = this.sendStandaloneReply(
          "⏹ cancelled",
          turn.sessionId,
          targetMsgId,
          {
            turnId: turn.turnId,
            isTurnFinal: true,
            ...(finalizedToolSteps.length > 0
              ? { toolSteps: finalizedToolSteps }
              : {}),
          },
        );
        return;
      }

      if (this.needsFirstPromptInstructions(turn.sessionId)) {
        promptBlocks = [
          {
            type: "text",
            text: `<system_instructions>\n${DAEMON_INSTRUCTIONS}\n</system_instructions>`,
          },
          ...promptBlocks,
        ];
      }

      const result = await client.sessionPrompt({
        sessionId: turn.sessionId,
        prompt: promptBlocks,
      });
      this.instructionsDeliveredSessions.add(turn.sessionId);

      // Flush any coalesced deltas BEFORE emitting terminal reply or turn_state(idle).
      this.flushPendingTurnDelta(turn);

      const targetMsgId =
        turn.delegationMessageId ?? turn.clientMessageId ?? undefined;
      const collected = turn.chunks.join("");
      const isCancelled =
        turn.cancelledByCommand || result.stopReason === "cancelled";
      const finalizedToolSteps = this.finalizeToolSteps(turn, isCancelled);
      const finalReplyOpts = {
        turnId: turn.turnId,
        isTurnFinal: true as const,
        ...(finalizedToolSteps.length > 0
          ? { toolSteps: finalizedToolSteps }
          : {}),
      };

      if (turn.cancelledByCommand) {
        this.cancelAllPendingPermissions(true);
        finalReplyId = this.sendStandaloneReply(
          "⏹ cancelled",
          turn.sessionId,
          targetMsgId,
          finalReplyOpts,
        );
      } else if (collected.length > 0) {
        finalReplyId = this.sendStandaloneReply(
          collected,
          turn.sessionId,
          targetMsgId,
          finalReplyOpts,
        );
      } else if (
        turn.delegationMessageId !== null ||
        result.stopReason !== "end_turn" ||
        !turn.replyToolCalled
      ) {
        const fallbackText = `(no text output — stopReason: ${result.stopReason})`;
        finalReplyId = this.sendStandaloneReply(
          fallbackText,
          turn.sessionId,
          targetMsgId,
          finalReplyOpts,
        );
      }
      // Else: non-delegation end_turn where agent already called reply_to_hitl; emit no extra reply.
    } catch (err) {
      this.flushPendingTurnDelta(turn);
      // If client closed due to crash/shutdown, handleHarnessExit / shutdown already notified cleanly.
      if (!client.isClosed && !this.shuttingDown) {
        const targetMsgId =
          turn.delegationMessageId ?? turn.clientMessageId ?? undefined;
        const msg = err instanceof Error ? err.message : String(err);
        const finalizedToolSteps = this.finalizeToolSteps(
          turn,
          turn.cancelledByCommand,
        );
        finalReplyId = this.sendStandaloneReply(
          `⚠ Turn error: ${msg}`,
          turn.sessionId,
          targetMsgId,
          {
            turnId: turn.turnId,
            isTurnFinal: true,
            ...(finalizedToolSteps.length > 0
              ? { toolSteps: finalizedToolSteps }
              : {}),
          },
        );
      }
    } finally {
      this.clearTurnDeltaTimer(turn);
      if (this.runningTurns.get(turn.sessionId) === turn) {
        this.runningTurns.delete(turn.sessionId);
      }
      if (this.runningTurn === turn) {
        this.runningTurn = null;
        this.turnBusy = false;
      }
      if (!client.isClosed && !this.shuttingDown) {
        this.emitTurnState({
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          state: this.pendingPermissions.some((p) => !p.resolved)
            ? "waiting_approval"
            : "idle",
          finalReplyId,
        });
      }
      if (!this.shuttingDown && this.client && !this.client.isClosed) {
        void this.drainQueue();
      }
    }
  }

  private async buildPromptBlocks(
    input: InboundMessage,
  ): Promise<AcpContentBlock[]> {
    const attachments = input.attachments ?? [];
    const images: HitlAttachment[] = [];
    const nonImages: HitlAttachment[] = [];

    for (const att of attachments) {
      if (!att || typeof att !== "object") continue;
      const isImage =
        att.type === "image" ||
        (typeof att.media_type === "string" && att.media_type.startsWith("image/"));
      if (isImage) {
        images.push(att);
      } else {
        nonImages.push(att);
      }
    }

    const promptText =
      nonImages.length > 0
        ? await this.processAttachmentsFn(input.text, nonImages)
        : input.text;

    const blocks: AcpContentBlock[] = [];
    if (promptText.length > 0 || images.length === 0) {
      blocks.push({ type: "text", text: promptText });
    }
    for (const img of images) {
      if (!img.data || typeof img.data !== "string") {
        process.stderr.write(
          `[hitl-channel] Skipping image attachment (missing data): fileName=${img.fileName ?? "(none)"}\n`,
        );
        continue;
      }
      blocks.push({
        type: "image",
        data: img.data,
        mimeType: img.media_type || "image/png",
      });
    }
    return blocks;
  }

  private async drainQueue(): Promise<void> {
    if (
      this.turnBusy ||
      this.sessionOpInFlight ||
      this.pendingPermissions.length > 0 ||
      this.shuttingDown
    ) {
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    await this.startTurn(next);
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.workerGcTimer) {
      clearInterval(this.workerGcTimer);
      this.workerGcTimer = null;
    }

    if (this.outOfTurnTimer) {
      clearTimeout(this.outOfTurnTimer);
      this.outOfTurnTimer = null;
    }

    const abortedTurn = this.runningTurn;
    const hadActiveWork =
      abortedTurn !== null ||
      this.pendingPermissions.length > 0 ||
      this.queue.length > 0;
    if (abortedTurn) {
      this.flushPendingTurnDelta(abortedTurn);
      this.clearTurnDeltaTimer(abortedTurn);
    }
    this.runningTurn = null;
    this.runningTurns.clear();
    this.turnBusy = false;

    this.cancelAllPendingPermissions(true);
    for (const sid of Array.from(this.pendingPermissionsBySession.keys())) {
      this.cancelWorkerPendingPermissions(sid, true);
    }
    this.sessionQueues.clear();
    this.pendingWorkerMcpChoices.clear();
    while (this.workerProcessWaiters.length > 0) {
      this.workerProcessWaiters.shift()?.();
    }
    this.queue.length = 0;
    this.openUserChoiceIds.clear();
    this.replayCaptureBuffers.clear();
    this.inFlightSessionLoads.clear();
    this.loadingSessionIds.clear();
    this.seenToolCalls.clear();
    this.instructionsDeliveredSessions.clear();
    this.sessionModelsMap.clear();
    this.sessionCommandsMap.clear();

    if (hadActiveWork) {
      this.emitTurnState({
        sessionId: abortedTurn?.sessionId ?? this.activeSessionId,
        ...(abortedTurn ? { turnId: abortedTurn.turnId } : {}),
        state: "idle",
        finalReplyId: null,
      });
    }

    const toClose = this.client ?? this.pendingClient;
    if (toClose) {
      await toClose.close();
      this.client = null;
      this.pendingClient = null;
    }
    const secondaryProcs = [...this.workerProcesses];
    this.workerProcesses.length = 0;
    for (const proc of secondaryProcs) {
      await proc.client.close().catch(() => {});
    }
    if (this.startPromise) {
      await this.startPromise.catch(() => {});
    }
  }

  // ─── SPEC-HITL-APP-10832 Phase 1a — Worker Pool & Peer Orchestration ────

  private recordInboundEventId(eventId: string): boolean {
    if (this.processedInboundEventIds.has(eventId)) return false;
    if (
      this.processedInboundEventIds.size >=
      AcpSessionManager.MAX_PROCESSED_INBOUND_EVENTS
    ) {
      const oldest = this.processedInboundEventIds.values().next().value;
      if (oldest !== undefined) {
        this.processedInboundEventIds.delete(oldest);
      }
    }
    this.processedInboundEventIds.add(eventId);
    return true;
  }

  private getWorkerProcessForClient(
    client: AcpClient,
  ): WorkerProcessEntry | undefined {
    return this.workerProcesses.find((p) => p.client === client);
  }

  private releaseWorkerProcessTurn(client: AcpClient, sessionId: string): void {
    const proc = this.getWorkerProcessForClient(client);
    if (!proc) return;
    proc.busySessionIds.delete(sessionId);
    proc.lastUsedAt = this.nowMs();
    while (this.workerProcessWaiters.length > 0) {
      this.workerProcessWaiters.shift()?.();
    }
  }

  private async acquireSecondaryWorkerProcess(
    preferredSessionId?: string,
  ): Promise<WorkerProcessEntry> {
    while (!this.shuttingDown) {
      if (preferredSessionId) {
        const owner = this.workerProcesses.find(
          (p) => !p.client.isClosed && p.sessionIds.has(preferredSessionId),
        );
        if (owner) {
          if (owner.busySessionIds.size === 0) {
            return owner;
          }
          await new Promise<void>((resolve) =>
            this.workerProcessWaiters.push(resolve),
          );
          continue;
        }
      }

      const idle = this.workerProcesses.find(
        (p) => !p.client.isClosed && p.busySessionIds.size === 0,
      );
      if (idle) {
        return idle;
      }

      if (this.workerProcesses.length < this.maxWorkerProcesses) {
        const launch = resolveHarnessLaunch(this.harness);
        const transport = this.transportFactory(launch.command, launch.args, {
          cwd: this.defaultCwd,
        });
        const client = new AcpClient(transport);
        client.onSessionUpdate((params) => this.handleSessionUpdate(params));
        client.onPermissionRequest((id, params) =>
          this.handlePermissionRequest(client, id, params),
        );
        client.onExit((code, signal) =>
          this.handleHarnessExit(client, code, signal),
        );
        try {
          const initRes = await client.initialize();
          if (this.shuttingDown) {
            await client.close().catch(() => {});
            throw new Error("Daemon shut down during worker subprocess init");
          }
          const entry: WorkerProcessEntry = {
            id: `worker-proc-${++this.workerProcessSeq}`,
            client,
            capabilities: initRes.agentCapabilities ?? {},
            busySessionIds: new Set(),
            sessionIds: new Set(),
            lastUsedAt: this.nowMs(),
          };
          this.workerProcesses.push(entry);
          return entry;
        } catch (err) {
          await client.close().catch(() => {});
          throw err;
        }
      }

      await new Promise<void>((resolve) =>
        this.workerProcessWaiters.push(resolve),
      );
    }
    throw new Error("Daemon is shutting down");
  }

  private isWorkerSessionIdle(sessionId: string): boolean {
    const entry = this.workerSessions.get(sessionId);
    if (!entry) return false;
    if (entry.activeRunId !== null) return false;
    if (this.runningTurns.has(sessionId)) return false;
    if ((this.sessionQueues.get(sessionId)?.length ?? 0) > 0) return false;
    if ((this.pendingPermissionsBySession.get(sessionId)?.length ?? 0) > 0) {
      return false;
    }
    return true;
  }

  private async evictWorkerSession(sessionId: string): Promise<boolean> {
    const entry = this.workerSessions.get(sessionId);
    if (!entry) return false;

    this.workerSessions.delete(sessionId);
    this.workerContextBySessionId.delete(sessionId);
    this.sessionQueues.delete(sessionId);
    this.pendingPermissionsBySession.delete(sessionId);
    this.instructionsDeliveredSessions.delete(sessionId);
    this.sessionModelsMap.delete(sessionId);
    this.sessionCommandsMap.delete(sessionId);
    this.evictedWorkerSessionIds.add(sessionId);

    for (const [bindingId, sid] of Array.from(this.mcpBindings.entries())) {
      if (sid === sessionId) {
        this.mcpBindings.delete(bindingId);
      }
    }
    for (const key of Array.from(this.seenToolCalls.keys())) {
      if (key.startsWith(`${sessionId}:`)) {
        this.seenToolCalls.delete(key);
      }
    }

    const supportsClose = Boolean(entry.capabilities.sessionCapabilities?.close);
    if (supportsClose && !entry.client.isClosed) {
      await entry.client.closeSession(sessionId).catch((err) => {
        process.stderr.write(
          `[hitl-channel] session/close failed for worker ${sessionId}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      });
    }

    const proc = this.getWorkerProcessForClient(entry.client);
    if (proc) {
      proc.sessionIds.delete(sessionId);
      if (!supportsClose && proc.sessionIds.size === 0 && proc.busySessionIds.size === 0) {
        const idx = this.workerProcesses.indexOf(proc);
        if (idx !== -1) {
          this.workerProcesses.splice(idx, 1);
          await proc.client.close().catch(() => {});
        }
      }
    }

    return true;
  }

  async runWorkerGc(): Promise<number> {
    if (this.shuttingDown) return 0;
    let evicted = 0;
    if (this.workerIdleTtlMs > 0) {
      const cutoff = this.nowMs() - this.workerIdleTtlMs;
      const expiredIds: string[] = [];
      for (const [sid, entry] of this.workerSessions.entries()) {
        if (entry.lastActiveAt <= cutoff && this.isWorkerSessionIdle(sid)) {
          expiredIds.push(sid);
        }
      }
      for (const sid of expiredIds) {
        if (await this.evictWorkerSession(sid)) {
          evicted++;
        }
      }
    }
    return evicted;
  }

  private async ensureWorkerPoolCapacity(): Promise<void> {
    await this.runWorkerGc();
    while (this.workerSessions.size >= this.maxWorkerSessions) {
      let oldestIdle: WorkerSessionEntry | undefined;
      for (const entry of this.workerSessions.values()) {
        if (!this.isWorkerSessionIdle(entry.sessionId)) continue;
        if (!oldestIdle || entry.lastActiveAt < oldestIdle.lastActiveAt) {
          oldestIdle = entry;
        }
      }
      if (!oldestIdle) {
        throw new Error("worker_pool_full");
      }
      await this.evictWorkerSession(oldestIdle.sessionId);
    }
  }

  private sendHostRunAck(
    ws: HitlWebSocket | undefined,
    payload: { event_id?: string; run_id?: string; acp_session_id?: string },
  ): void {
    const frame: HostRunAckFrame = {
      type: "host_run_ack",
      ...(payload.event_id ? { event_id: payload.event_id } : {}),
      ...(payload.run_id ? { run_id: payload.run_id } : {}),
      ...(payload.acp_session_id ? { acp_session_id: payload.acp_session_id } : {}),
    };
    if (ws && ws.readyState === 1 && ws.data?.features?.has("peer_orchestration")) {
      if (
        this.sendControlToClientFn(
          ws,
          frame as unknown as Record<string, unknown>,
          "peer_orchestration",
        )
      ) {
        return;
      }
    }
    this.broadcastToCapableFn(
      "peer_orchestration",
      frame as unknown as Record<string, unknown>,
    );
  }

  private async allocateWorkerSession(
    frame: HostRunStartFrame,
  ): Promise<{ client: AcpClient; capabilities: AcpAgentCapabilities; sessionId: string; cwd: string }> {
    const absCwd = frame.cwd
      ? expandHomeAndResolve(frame.cwd, this.defaultCwd)
      : this.defaultCwd;
    const requestedSessionId =
      typeof frame.acp_session_id === "string" && frame.acp_session_id.trim().length > 0
        ? frame.acp_session_id.trim()
        : undefined;
    const externalKey =
      typeof frame.external_session_key === "string" &&
      frame.external_session_key.trim().length > 0
        ? frame.external_session_key.trim()
        : undefined;

    if (requestedSessionId) {
      if (this.evictedWorkerSessionIds.has(requestedSessionId)) {
        throw new Error(`host_session_expired: session '${requestedSessionId}' was closed`);
      }
      const existing = this.workerSessions.get(requestedSessionId);
      if (existing && !existing.client.isClosed) {
        const proc = this.getWorkerProcessForClient(existing.client);
        if (proc && proc.busySessionIds.size > 0) {
          await this.acquireSecondaryWorkerProcess(requestedSessionId);
        }
        existing.lastActiveAt = this.nowMs();
        return {
          client: existing.client,
          capabilities: existing.capabilities,
          sessionId: existing.sessionId,
          cwd: existing.cwd,
        };
      }
    }

    if (!requestedSessionId && externalKey) {
      for (const existing of this.workerSessions.values()) {
        if (
          existing.externalSessionKey === externalKey &&
          !existing.client.isClosed
        ) {
          const proc = this.getWorkerProcessForClient(existing.client);
          if (proc && proc.busySessionIds.size > 0) {
            await this.acquireSecondaryWorkerProcess(existing.sessionId);
          }
          existing.lastActiveAt = this.nowMs();
          return {
            client: existing.client,
            capabilities: existing.capabilities,
            sessionId: existing.sessionId,
            cwd: existing.cwd,
          };
        }
      }
    }

    await this.ensureWorkerPoolCapacity();

    const usePrimary = this.concurrentSessions && !this.primarySerializesTurns;
    let client: AcpClient;
    let capabilities: AcpAgentCapabilities;
    let procEntry: WorkerProcessEntry | undefined;

    if (usePrimary) {
      client = await this.ensureClient();
      capabilities = this.agentCapabilities;
    } else {
      procEntry = await this.acquireSecondaryWorkerProcess(requestedSessionId);
      client = procEntry.client;
      capabilities = procEntry.capabilities;
    }

    const switchToSecondaryOnBusy = async (): Promise<void> => {
      this.primarySerializesTurns = true;
      procEntry = await this.acquireSecondaryWorkerProcess(requestedSessionId);
      client = procEntry.client;
      capabilities = procEntry.capabilities;
    };

    if (requestedSessionId) {
      const mcpBindingId = this.preMintMcpBindingId();
      this.bindMcpSession(mcpBindingId, requestedSessionId);
      const loadWithClient = async (targetClient: AcpClient, caps: AcpAgentCapabilities) => {
        const params = {
          sessionId: requestedSessionId,
          cwd: absCwd,
          mcpServers: [this.buildMcpServer(mcpBindingId)],
          ...this.buildSessionInitExtensions(),
        };
        if (caps.loadSession) {
          await targetClient.sessionLoad(params);
        } else if (caps.sessionCapabilities?.resume) {
          await targetClient.sessionResume(params);
        } else {
          throw new Error(
            `host_session_expired: harness does not support resuming '${requestedSessionId}'`,
          );
        }
      };
      this.loadingSessionIds.add(requestedSessionId);
      try {
        try {
          await loadWithClient(client, capabilities);
        } catch (err) {
          if (client === this.client && isConcurrencyBusyError(err)) {
            await switchToSecondaryOnBusy();
            await loadWithClient(client, capabilities);
          } else {
            throw err;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("host_session_expired")) throw err;
        throw new Error(`host_session_expired: ${msg}`);
      } finally {
        this.loadingSessionIds.delete(requestedSessionId);
      }

      this.workerCreatedSessionIds.add(requestedSessionId);
      procEntry?.sessionIds.add(requestedSessionId);
      const entry: WorkerSessionEntry = {
        sessionId: requestedSessionId,
        client,
        capabilities,
        cwd: absCwd,
        ...(externalKey ? { externalSessionKey: externalKey } : {}),
        createdAt: this.nowMs(),
        lastActiveAt: this.nowMs(),
        activeRunId: null,
      };
      this.workerSessions.set(requestedSessionId, entry);
      return { client, capabilities, sessionId: requestedSessionId, cwd: absCwd };
    }

    const mcpBindingId = this.preMintMcpBindingId();
    let res: { sessionId: string };
    try {
      res = await client.sessionNew({
        cwd: absCwd,
        mcpServers: [this.buildMcpServer(mcpBindingId)],
        ...this.buildSessionInitExtensions(),
      });
    } catch (err) {
      if (client === this.client && isConcurrencyBusyError(err)) {
        await switchToSecondaryOnBusy();
        res = await client.sessionNew({
          cwd: absCwd,
          mcpServers: [this.buildMcpServer(mcpBindingId)],
          ...this.buildSessionInitExtensions(),
        });
      } else {
        throw err;
      }
    }
    this.bindMcpSession(mcpBindingId, res.sessionId);
    this.workerCreatedSessionIds.add(res.sessionId);
    procEntry?.sessionIds.add(res.sessionId);
    const entry: WorkerSessionEntry = {
      sessionId: res.sessionId,
      client,
      capabilities,
      cwd: absCwd,
      ...(externalKey ? { externalSessionKey: externalKey } : {}),
      createdAt: this.nowMs(),
      lastActiveAt: this.nowMs(),
      activeRunId: null,
    };
    this.workerSessions.set(res.sessionId, entry);
    return { client, capabilities, sessionId: res.sessionId, cwd: absCwd };
  }

  private async spillWorkerTurnToSecondary(
    runState: WorkerRunState,
    promptBlocks: AcpContentBlock[],
  ): Promise<{ stopReason: string; chunks: string[]; newSessionId: string }> {
    this.primarySerializesTurns = true;
    const proc = await this.acquireSecondaryWorkerProcess();
    const mcpBindingId = this.preMintMcpBindingId();
    const res = await proc.client.sessionNew({
      cwd: runState.cwd,
      mcpServers: [this.buildMcpServer(mcpBindingId)],
      ...this.buildSessionInitExtensions(),
    });
    const newSid = res.sessionId;
    this.bindMcpSession(mcpBindingId, newSid);
    this.workerCreatedSessionIds.add(newSid);
    proc.sessionIds.add(newSid);

    const oldSid = runState.acpSessionId;
    const oldEntry = this.workerSessions.get(oldSid);
    if (oldEntry) {
      this.workerSessions.delete(oldSid);
    }
    const oldCtx = this.workerContextBySessionId.get(oldSid);
    if (oldCtx) {
      this.workerContextBySessionId.delete(oldSid);
    }

    runState.acpSessionId = newSid;
    this.workerContextBySessionId.set(newSid, {
      runId: runState.runId,
      acpSessionId: newSid,
      parentRunId: runState.parentRunId,
      episodeRootRunId: runState.episodeRootRunId,
      dispatchDepth: runState.dispatchDepth,
      messageHop: runState.messageHop,
      ...(runState.externalSessionKey
        ? { externalSessionKey: runState.externalSessionKey }
        : {}),
      cwd: runState.cwd,
    });
    this.workerSessions.set(newSid, {
      sessionId: newSid,
      client: proc.client,
      capabilities: proc.capabilities,
      cwd: runState.cwd,
      ...(runState.externalSessionKey
        ? { externalSessionKey: runState.externalSessionKey }
        : {}),
      createdAt: this.nowMs(),
      lastActiveAt: this.nowMs(),
      activeRunId: runState.runId,
    });
    this.sendHostRunAck(runState.ws, {
      run_id: runState.runId,
      acp_session_id: newSid,
    });

    const spilledTurn: RunningTurn = {
      turnId: `wturn-${this.nowMs()}-${++this.turnSeq}`,
      sessionId: newSid,
      isWorker: true,
      workerRunId: runState.runId,
      chunks: [],
      delegationMessageId: null,
      clientMessageId: null,
      replyToolCalled: false,
      cancelledByCommand: runState.cancelled,
      deltaSeq: 0,
      pendingDeltaText: "",
      deltaTimer: null,
      emittedDeltaBytes: 0,
      deltaTruncated: false,
      toolSteps: new Map(),
    };
    this.runningTurns.set(newSid, spilledTurn);
    proc.busySessionIds.add(newSid);
    try {
      const promptRes = await proc.client.sessionPrompt({
        sessionId: newSid,
        prompt: promptBlocks,
      });
      this.instructionsDeliveredSessions.add(newSid);
      return {
        stopReason: promptRes.stopReason,
        chunks: spilledTurn.chunks,
        newSessionId: newSid,
      };
    } finally {
      this.runningTurns.delete(newSid);
      this.releaseWorkerProcessTurn(proc.client, newSid);
    }
  }

  private async handleHostRunStart(
    ws: HitlWebSocket,
    frame: HostRunStartFrame,
  ): Promise<void> {
    const runId = typeof frame.run_id === "string" ? frame.run_id.trim() : "";
    const prompt = typeof frame.prompt === "string" ? frame.prompt : "";
    const eventId =
      typeof frame.event_id === "string" ? frame.event_id.trim() : "";
    if (!runId) return;

    const existing = this.workerRunsById.get(runId);
    if (existing) {
      if (existing.acpSessionId || eventId) {
        this.sendHostRunAck(ws, {
          ...(eventId ? { event_id: eventId } : {}),
          run_id: runId,
          ...(existing.acpSessionId
            ? { acp_session_id: existing.acpSessionId }
            : {}),
        });
      }
      return;
    }

    const absCwd = frame.cwd
      ? expandHomeAndResolve(frame.cwd, this.defaultCwd)
      : this.defaultCwd;
    const runState: WorkerRunState = {
      runId,
      acpSessionId: frame.acp_session_id ?? "",
      parentRunId: frame.parent_run_id ?? null,
      episodeRootRunId: frame.episode_root_run_id ?? null,
      dispatchDepth:
        typeof frame.dispatch_depth === "number" ? frame.dispatch_depth : 0,
      messageHop: typeof frame.message_hop === "number" ? frame.message_hop : 0,
      ...(typeof frame.external_session_key === "string"
        ? { externalSessionKey: frame.external_session_key }
        : {}),
      cwd: absCwd,
      cancelled: false,
      terminalEmitted: false,
      ws,
    };
    this.workerRunsById.set(runId, runState);

    if (runState.dispatchDepth > 3) {
      runState.terminalEmitted = true;
      this.emitWorkerEvent({
        type: "host_run_event",
        event_id: globalThis.crypto.randomUUID(),
        run_id: runId,
        acp_session_id: runState.acpSessionId,
        kind: "failed",
        pinned: true,
        reason: "max_dispatch_depth_exceeded",
        error: "max_dispatch_depth_exceeded",
        ts: new Date(this.nowMs()).toISOString(),
      });
      return;
    }

    try {
      const { sessionId } = await this.allocateWorkerSession(frame);
      if (runState.cancelled) {
        if (!runState.terminalEmitted) {
          runState.terminalEmitted = true;
          this.emitWorkerEvent({
            type: "host_run_event",
            event_id: globalThis.crypto.randomUUID(),
            run_id: runId,
            acp_session_id: sessionId,
            kind: "cancelled",
            pinned: true,
            reason: runState.cancelReason ?? "cancelled",
            ts: new Date(this.nowMs()).toISOString(),
          });
        }
        return;
      }

      runState.acpSessionId = sessionId;
      const sessEntry = this.workerSessions.get(sessionId);
      if (sessEntry) {
        sessEntry.activeRunId = runId;
        sessEntry.lastActiveAt = this.nowMs();
      }
      this.workerContextBySessionId.set(sessionId, {
        runId,
        acpSessionId: sessionId,
        parentRunId: runState.parentRunId,
        episodeRootRunId: runState.episodeRootRunId,
        dispatchDepth: runState.dispatchDepth,
        messageHop: runState.messageHop,
        ...(runState.externalSessionKey
          ? { externalSessionKey: runState.externalSessionKey }
          : {}),
        cwd: runState.cwd,
      });

      this.sendHostRunAck(ws, {
        ...(eventId ? { event_id: eventId } : {}),
        run_id: runId,
        acp_session_id: sessionId,
      });
      this.emitWorkerEvent({
        type: "host_run_event",
        event_id: globalThis.crypto.randomUUID(),
        run_id: runId,
        acp_session_id: sessionId,
        kind: "started",
        pinned: false,
        ts: new Date(this.nowMs()).toISOString(),
      });

      void this.queueTurnForSession(sessionId, prompt, {
        runId,
        isFollowUp: false,
      });
    } catch (err) {
      if (!runState.terminalEmitted) {
        runState.terminalEmitted = true;
        const msg = err instanceof Error ? err.message : String(err);
        const reason = msg.includes("host_session_expired")
          ? "host_session_expired"
          : msg.includes("worker_pool_full")
            ? "worker_pool_full"
            : "session_start_failed";
        this.emitWorkerEvent({
          type: "host_run_event",
          event_id: globalThis.crypto.randomUUID(),
          run_id: runId,
          acp_session_id: runState.acpSessionId,
          kind: "failed",
          pinned: true,
          reason,
          error: msg,
          ts: new Date(this.nowMs()).toISOString(),
        });
      }
    }
  }

  private async handleHostRunMessage(
    ws: HitlWebSocket,
    frame: HostRunMessageFrame,
  ): Promise<void> {
    const eventId = typeof frame.event_id === "string" ? frame.event_id.trim() : "";
    const runState =
      typeof frame.run_id === "string"
        ? this.workerRunsById.get(frame.run_id)
        : undefined;
    const acpSessionId =
      (typeof frame.acp_session_id === "string" && frame.acp_session_id.trim()) ||
      runState?.acpSessionId ||
      "";
    const sendAck = (): void => {
      this.sendHostRunAck(ws, {
        ...(eventId ? { event_id: eventId } : {}),
        ...(typeof frame.run_id === "string" && frame.run_id.trim().length > 0
          ? { run_id: frame.run_id.trim() }
          : {}),
        ...(acpSessionId ? { acp_session_id: acpSessionId } : {}),
      });
    };

    if (eventId && !this.recordInboundEventId(eventId)) {
      sendAck();
      return;
    }

    if (!acpSessionId) return;

    const ctx = this.workerContextBySessionId.get(acpSessionId);
    if (ctx && typeof frame.message_hop === "number") {
      ctx.messageHop = Math.max(ctx.messageHop, frame.message_hop);
    }
    if (runState && typeof frame.message_hop === "number") {
      runState.messageHop = Math.max(runState.messageHop, frame.message_hop);
    }

    if (frame.kind === "permission_response") {
      const choicesId =
        typeof frame.choices_id === "string" ? frame.choices_id.trim() : "";
      const optionId =
        typeof frame.option_id === "string" ? frame.option_id.trim() : "";

      if (choicesId && this.pendingWorkerMcpChoices.has(choicesId)) {
        const pendingChoice = this.pendingWorkerMcpChoices.get(choicesId)!;
        this.pendingWorkerMcpChoices.delete(choicesId);
        this.workerOutbox.unpinByChoicesId(choicesId);
        const matched =
          pendingChoice.options.find((o) => o.optionId === optionId) ??
          pendingChoice.options.find(
            (o) => o.name.toLowerCase() === optionId.toLowerCase(),
          );
        const answerText = matched?.name ?? optionId;
        await this.queueTurnForSession(
          pendingChoice.acpSessionId,
          `<hitl_system_event type="choice_response" choices_id="${choicesId}">${answerText}</hitl_system_event>`,
          { runId: pendingChoice.runId, isFollowUp: true },
        );
        sendAck();
        return;
      }

      const sessPerms = this.pendingPermissionsBySession.get(acpSessionId);
      if (!sessPerms || sessPerms.length === 0) {
        sendAck();
        return;
      }
      const permIdx = choicesId
        ? sessPerms.findIndex((p) => !p.resolved && p.choicesId === choicesId)
        : sessPerms.findIndex((p) => !p.resolved);
      if (permIdx === -1) {
        sendAck();
        return;
      }
      const perm = sessPerms[permIdx]!;
      const matchedOpt =
        perm.options.find((o) => o.optionId === optionId) ??
        perm.options.find(
          (o) =>
            o.optionId.toLowerCase() === optionId.toLowerCase() ||
            o.name.toLowerCase() === optionId.toLowerCase(),
        );
      if (!matchedOpt) return;

      sessPerms.splice(permIdx, 1);
      if (sessPerms.length === 0) {
        this.pendingPermissionsBySession.delete(acpSessionId);
      }
      perm.resolved = true;
      if (perm.choicesId) {
        this.workerOutbox.unpinByChoicesId(perm.choicesId);
      }
      if (!perm.client.isClosed) {
        perm.client.respond(perm.rpcId, {
          outcome: { outcome: "selected", optionId: matchedOpt.optionId },
        });
      }
      const approval = matchedOpt.kind.startsWith("reject")
        ? "user_denied"
        : "user_approved";
      this.emitPermissionAudit(
        perm.toolName,
        approval,
        perm.promptHash,
        acpSessionId,
      );
      sendAck();
      return;
    }

    if (frame.kind === "agent_message") {
      const text = typeof frame.text === "string" ? frame.text : "";
      if (!text.trim()) return;
      const senderAttr = frame.sender_agent_id
        ? ` sender_agent_id="${frame.sender_agent_id}"`
        : "";
      const nameAttr = frame.sender_name
        ? ` sender_name="${frame.sender_name}"`
        : "";
      const hopAttr =
        typeof frame.message_hop === "number"
          ? ` message_hop="${frame.message_hop}"`
          : "";
      const envelope = `<hitl_system_event type="agent_message" event_id="${eventId}" run_id="${frame.run_id}"${senderAttr}${nameAttr}${hopAttr}>\n${text}\n</hitl_system_event>`;
      await this.queueTurnForSession(acpSessionId, envelope, {
        runId: frame.run_id,
        isFollowUp: true,
      });
      sendAck();
    }
  }

  private async handleHostRunCancel(
    ws: HitlWebSocket,
    frame: HostRunCancelFrame,
  ): Promise<void> {
    const runId = typeof frame.run_id === "string" ? frame.run_id.trim() : "";
    const eventId =
      typeof frame.event_id === "string" ? frame.event_id.trim() : "";
    let runState = runId ? this.workerRunsById.get(runId) : undefined;
    if (!runState && typeof frame.acp_session_id === "string") {
      const ctx = this.workerContextBySessionId.get(frame.acp_session_id);
      if (ctx) runState = this.workerRunsById.get(ctx.runId);
    }
    const sid =
      runState?.acpSessionId ||
      (typeof frame.acp_session_id === "string" ? frame.acp_session_id : "") ||
      "";
    const sendCancelAck = (): void => {
      if (eventId || runId) {
        this.sendHostRunAck(ws, {
          ...(eventId ? { event_id: eventId } : {}),
          ...(runId ? { run_id: runId } : {}),
          ...(sid ? { acp_session_id: sid } : {}),
        });
      }
    };
    if (!runState || runState.terminalEmitted) {
      sendCancelAck();
      return;
    }

    runState.cancelled = true;
    runState.cancelReason =
      typeof frame.reason === "string" && frame.reason.trim().length > 0
        ? frame.reason.trim()
        : "cancelled";

    if (!sid) {
      runState.terminalEmitted = true;
      this.emitWorkerEvent({
        type: "host_run_event",
        event_id: globalThis.crypto.randomUUID(),
        run_id: runState.runId,
        acp_session_id: "",
        kind: "cancelled",
        pinned: true,
        reason: runState.cancelReason,
        ts: new Date(this.nowMs()).toISOString(),
      });
      sendCancelAck();
      return;
    }

    this.cancelWorkerPendingPermissions(sid, true);
    const q = this.sessionQueues.get(sid);
    if (q) {
      const filtered = q.filter((item) => item.runId !== runState!.runId);
      if (filtered.length === 0) {
        this.sessionQueues.delete(sid);
      } else {
        this.sessionQueues.set(sid, filtered);
      }
    }

    const activeTurn = this.runningTurns.get(sid);
    const sessEntry = this.workerSessions.get(sid);
    if (activeTurn && activeTurn.isWorker && activeTurn.workerRunId === runState.runId) {
      activeTurn.cancelledByCommand = true;
      if (sessEntry && !sessEntry.client.isClosed) {
        sessEntry.client.sessionCancel(sid);
      }
      sendCancelAck();
      return;
    }

    if (!runState.terminalEmitted) {
      runState.terminalEmitted = true;
      if (sessEntry) {
        sessEntry.activeRunId = null;
        sessEntry.lastActiveAt = this.nowMs();
      }
      this.emitWorkerEvent({
        type: "host_run_event",
        event_id: globalThis.crypto.randomUUID(),
        run_id: runState.runId,
        acp_session_id: sid,
        kind: "cancelled",
        pinned: true,
        reason: runState.cancelReason,
        ts: new Date(this.nowMs()).toISOString(),
      });
    }
    sendCancelAck();
  }

  private handleHostRunAck(frame: HostRunAckFrame): void {
    const eventId = typeof frame.event_id === "string" ? frame.event_id.trim() : "";
    if (!eventId) return;
    this.workerOutbox.commitById(eventId);
  }

  private async handlePhoneRunWake(
    ws: HitlWebSocket,
    frame: PhoneRunWakeFrame,
  ): Promise<void> {
    const eventId = typeof frame.event_id === "string" ? frame.event_id.trim() : "";
    const acpSessionId =
      typeof frame.acp_session_id === "string"
        ? frame.acp_session_id.trim()
        : "";
    if (!acpSessionId) return;

    if (eventId && !this.recordInboundEventId(eventId)) {
      this.sendHostRunAck(ws, {
        event_id: eventId,
        run_id: frame.run_id,
        acp_session_id: acpSessionId,
      });
      return;
    }

    const ctx = this.workerContextBySessionId.get(acpSessionId);
    if (ctx && typeof frame.message_hop === "number") {
      ctx.messageHop = Math.max(ctx.messageHop, frame.message_hop);
    }

    const bodyText =
      frame.status === "failed"
        ? frame.error ?? "Phone agent run failed."
        : frame.output ?? "";
    const senderAttr = frame.sender_agent_id
      ? ` sender_agent_id="${frame.sender_agent_id}"`
      : "";
    const nameAttr = frame.sender_name
      ? ` sender_name="${frame.sender_name}"`
      : "";
    const hopAttr =
      typeof frame.message_hop === "number"
        ? ` message_hop="${frame.message_hop}"`
        : "";
    const wakeEnvelope = `<phone_agent_event event_id="${eventId}" run_id="${frame.run_id}" status="${frame.status}"${senderAttr}${nameAttr}${hopAttr}>\n${bodyText}\n</phone_agent_event>`;

    await this.queueTurnForSession(acpSessionId, wakeEnvelope, {
      runId: ctx?.runId,
      isFollowUp: true,
    });

    this.sendHostRunAck(ws, {
      ...(eventId ? { event_id: eventId } : {}),
      run_id: frame.run_id,
      acp_session_id: acpSessionId,
    });
  }

  async queueTurnForSession(
    acpSessionId: string,
    promptText: string,
    opts?: { runId?: string; isFollowUp?: boolean },
  ): Promise<void> {
    if (this.shuttingDown) return;

    if (!this.isWorkerSession(acpSessionId)) {
      if (acpSessionId === this.activeSessionId) {
        await this.handleInbound({
          text: promptText,
          meta: { sender_id: "phone_agent", type: "phone_run_wake" },
        });
        return;
      }
      // Non-active interactive session: queue onto sessionQueues & execute on primary client
      const q = this.sessionQueues.get(acpSessionId) ?? [];
      q.push({ prompt: promptText, runId: opts?.runId, isFollowUp: opts?.isFollowUp });
      this.sessionQueues.set(acpSessionId, q);
      if (!this.runningTurns.has(acpSessionId)) {
        void this.drainInteractiveSessionQueue(acpSessionId);
      }
      return;
    }

    const q = this.sessionQueues.get(acpSessionId) ?? [];
    q.push({
      prompt: promptText,
      runId: opts?.runId,
      isFollowUp: opts?.isFollowUp,
    });
    this.sessionQueues.set(acpSessionId, q);

    if (!this.runningTurns.has(acpSessionId)) {
      await this.drainWorkerSessionQueue(acpSessionId);
    }
  }

  private async drainInteractiveSessionQueue(acpSessionId: string): Promise<void> {
    if (this.shuttingDown || this.runningTurns.has(acpSessionId)) return;
    const q = this.sessionQueues.get(acpSessionId);
    if (!q || q.length === 0) {
      this.sessionQueues.delete(acpSessionId);
      return;
    }
    const next = q.shift()!;
    if (q.length === 0) this.sessionQueues.delete(acpSessionId);
    try {
      const client = await this.ensureClient();
      const blocks: AcpContentBlock[] = [{ type: "text", text: next.prompt }];
      const turn: RunningTurn = {
        turnId: `iturn-${this.nowMs()}-${++this.turnSeq}`,
        sessionId: acpSessionId,
        isWorker: false,
        chunks: [],
        delegationMessageId: null,
        clientMessageId: null,
        replyToolCalled: false,
        cancelledByCommand: false,
        deltaSeq: 0,
        pendingDeltaText: "",
        deltaTimer: null,
        emittedDeltaBytes: 0,
        deltaTruncated: false,
        toolSteps: new Map(),
      };
      this.runningTurns.set(acpSessionId, turn);
      try {
        await client.sessionPrompt({ sessionId: acpSessionId, prompt: blocks });
      } finally {
        this.runningTurns.delete(acpSessionId);
      }
    } catch (err) {
      process.stderr.write(
        `[hitl-channel] session turn error (${acpSessionId}): ${
          err instanceof Error ? err.message : err
        }\n`,
      );
    } finally {
      if ((this.sessionQueues.get(acpSessionId)?.length ?? 0) > 0) {
        void this.drainInteractiveSessionQueue(acpSessionId);
      }
    }
  }

  private async drainWorkerSessionQueue(acpSessionId: string): Promise<void> {
    if (this.shuttingDown || this.runningTurns.has(acpSessionId)) return;
    const q = this.sessionQueues.get(acpSessionId);
    if (!q || q.length === 0) {
      this.sessionQueues.delete(acpSessionId);
      return;
    }

    const entry = this.workerSessions.get(acpSessionId);
    if (!entry || entry.client.isClosed) {
      this.sessionQueues.delete(acpSessionId);
      return;
    }

    const next = q.shift()!;
    if (q.length === 0) {
      this.sessionQueues.delete(acpSessionId);
    }

    const runId =
      next.runId ?? this.workerContextBySessionId.get(acpSessionId)?.runId ?? "";
    const runState = runId ? this.workerRunsById.get(runId) : undefined;
    if (runState?.cancelled && !next.isFollowUp) {
      return;
    }

    await this.executeWorkerTurn(entry, acpSessionId, next.prompt, runState, Boolean(next.isFollowUp));

    // Continue draining if more queued items arrived during the turn (use latest sessionId in case of spill)
    const activeSid = runState?.acpSessionId || acpSessionId;
    if (!this.shuttingDown && (this.sessionQueues.get(activeSid)?.length ?? 0) > 0) {
      void this.drainWorkerSessionQueue(activeSid);
    }
  }

  private async executeWorkerTurn(
    entry: WorkerSessionEntry,
    sessionId: string,
    promptText: string,
    runState: WorkerRunState | undefined,
    isFollowUp: boolean,
  ): Promise<void> {
    const turn: RunningTurn = {
      turnId: `wturn-${this.nowMs()}-${++this.turnSeq}`,
      sessionId,
      isWorker: true,
      workerRunId: runState?.runId,
      chunks: [],
      delegationMessageId: null,
      clientMessageId: null,
      replyToolCalled: false,
      cancelledByCommand: runState?.cancelled ?? false,
      deltaSeq: 0,
      pendingDeltaText: "",
      deltaTimer: null,
      emittedDeltaBytes: 0,
      deltaTruncated: false,
      toolSteps: new Map(),
    };

    this.runningTurns.set(sessionId, turn);
    entry.activeRunId = runState?.runId ?? null;
    entry.lastActiveAt = this.nowMs();
    const proc = this.getWorkerProcessForClient(entry.client);
    proc?.busySessionIds.add(sessionId);

    let activeSessionIdForEvent = sessionId;
    let clientForTurn = entry.client;

    try {
      let promptBlocks: AcpContentBlock[] = [{ type: "text", text: promptText }];
      if (this.needsFirstPromptInstructions(sessionId)) {
        promptBlocks = [
          {
            type: "text",
            text: `<system_instructions>\n${DAEMON_INSTRUCTIONS}\n</system_instructions>`,
          },
          ...promptBlocks,
        ];
      }

      if (turn.cancelledByCommand) {
        if (runState && !runState.terminalEmitted) {
          runState.terminalEmitted = true;
          this.emitWorkerEvent({
            type: "host_run_event",
            event_id: globalThis.crypto.randomUUID(),
            run_id: runState.runId,
            acp_session_id: activeSessionIdForEvent,
            kind: "cancelled",
            pinned: true,
            reason: runState.cancelReason ?? "cancelled",
            ts: new Date(this.nowMs()).toISOString(),
          });
        }
        return;
      }

      let stopReason: string;
      let collectedChunks: string[];

      try {
        const res = await clientForTurn.sessionPrompt({
          sessionId,
          prompt: promptBlocks,
        });
        this.instructionsDeliveredSessions.add(sessionId);
        stopReason = res.stopReason;
        collectedChunks = turn.chunks;
      } catch (err) {
        if (
          clientForTurn === this.client &&
          !clientForTurn.isClosed &&
          runState &&
          isConcurrencyBusyError(err)
        ) {
          this.runningTurns.delete(sessionId);
          this.releaseWorkerProcessTurn(clientForTurn, sessionId);
          const spilled = await this.spillWorkerTurnToSecondary(
            runState,
            promptBlocks,
          );
          activeSessionIdForEvent = spilled.newSessionId;
          stopReason = spilled.stopReason;
          collectedChunks = spilled.chunks;
        } else {
          throw err;
        }
      }

      const output = collectedChunks.join("");
      const isCancelled =
        turn.cancelledByCommand ||
        Boolean(runState?.cancelled) ||
        stopReason === "cancelled";

      if (runState) {
        if (isCancelled) {
          if (!runState.terminalEmitted) {
            runState.terminalEmitted = true;
            this.emitWorkerEvent({
              type: "host_run_event",
              event_id: globalThis.crypto.randomUUID(),
              run_id: runState.runId,
              acp_session_id: activeSessionIdForEvent,
              kind: "cancelled",
              pinned: true,
              reason: runState.cancelReason ?? "cancelled",
              ts: new Date(this.nowMs()).toISOString(),
            });
          }
        } else if (runState.terminalEmitted || isFollowUp) {
          const hasQueuedMore =
            (this.sessionQueues.get(activeSessionIdForEvent)?.length ?? 0) > 0;
          if (!runState.terminalEmitted && !hasQueuedMore) {
            runState.terminalEmitted = true;
            this.emitWorkerEvent({
              type: "host_run_event",
              event_id: globalThis.crypto.randomUUID(),
              run_id: runState.runId,
              acp_session_id: activeSessionIdForEvent,
              kind: "completed",
              pinned: true,
              output,
              ts: new Date(this.nowMs()).toISOString(),
            });
          } else if (output.length > 0) {
            this.emitWorkerEvent({
              type: "host_run_event",
              event_id: globalThis.crypto.randomUUID(),
              run_id: runState.runId,
              acp_session_id: activeSessionIdForEvent,
              kind: "agent_message",
              pinned: false,
              text: output,
              ts: new Date(this.nowMs()).toISOString(),
            });
          }
        } else {
          const hasQueuedMore =
            (this.sessionQueues.get(activeSessionIdForEvent)?.length ?? 0) > 0;
          if (hasQueuedMore) {
            if (output.length > 0) {
              this.emitWorkerEvent({
                type: "host_run_event",
                event_id: globalThis.crypto.randomUUID(),
                run_id: runState.runId,
                acp_session_id: activeSessionIdForEvent,
                kind: "agent_message",
                pinned: false,
                text: output,
                ts: new Date(this.nowMs()).toISOString(),
              });
            }
          } else {
            runState.terminalEmitted = true;
            this.emitWorkerEvent({
              type: "host_run_event",
              event_id: globalThis.crypto.randomUUID(),
              run_id: runState.runId,
              acp_session_id: activeSessionIdForEvent,
              kind: "completed",
              pinned: true,
              output,
              ts: new Date(this.nowMs()).toISOString(),
            });
          }
        }
      }
    } catch (err) {
      if (!clientForTurn.isClosed && !this.shuttingDown && runState && !runState.terminalEmitted) {
        runState.terminalEmitted = true;
        this.emitWorkerEvent({
          type: "host_run_event",
          event_id: globalThis.crypto.randomUUID(),
          run_id: runState.runId,
          acp_session_id: activeSessionIdForEvent,
          kind: "failed",
          pinned: true,
          reason: "turn_error",
          error: err instanceof Error ? err.message : String(err),
          ts: new Date(this.nowMs()).toISOString(),
        });
      }
    } finally {
      this.runningTurns.delete(sessionId);
      this.runningTurns.delete(activeSessionIdForEvent);
      this.releaseWorkerProcessTurn(clientForTurn, sessionId);
      const latestEntry = this.workerSessions.get(activeSessionIdForEvent);
      if (latestEntry) {
        const hasPendingMore =
          (this.sessionQueues.get(activeSessionIdForEvent)?.length ?? 0) > 0;
        if (!hasPendingMore) {
          latestEntry.activeRunId = null;
        }
        latestEntry.lastActiveAt = this.nowMs();
      }
    }
  }
}
