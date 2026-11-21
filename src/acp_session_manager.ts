import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AcpClient,
  spawnAcpTransport,
  type AcpAgentCapabilities,
  type AcpContentBlock,
  type AcpMcpServer,
  type AcpPermissionOption,
  type AcpPermissionRequestParams,
  type AcpPermissionToolCall,
  type AcpSessionInfo,
  type AcpSessionUpdateParams,
  type AcpSystemPrompt,
  type AcpTransport,
} from "./acp_client.js";
import { appendAudit, sha256Hex, stableStringify } from "./audit.js";
import {
  broadcastReply,
  processAttachments,
  unicastFrame,
  type InboundHandlers,
  type InboundMessage,
} from "./http_bridge.js";
import { DAEMON_INSTRUCTIONS } from "./mcp_instructions.js";
import type { HitlAttachment } from "./types.js";

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

interface PendingPermission {
  rpcId: string | number;
  sessionId: string;
  toolName: string;
  promptHash: string;
  frame: Record<string, unknown>;
  options: AcpPermissionOption[];
  resolved: boolean;
}

interface QueuedTurn {
  input: InboundMessage;
  isChoiceResponse: boolean;
}

interface RunningTurn {
  sessionId: string;
  chunks: string[];
  delegationMessageId: string | null;
  clientMessageId: string | null;
  replyToolCalled: boolean;
  cancelledByCommand: boolean;
}

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
  broadcastReplyFn?: typeof broadcastReply;
  unicastFrameFn?: typeof unicastFrame;
  auditFn?: typeof appendAudit;
  processAttachmentsFn?: typeof processAttachments;
  outOfTurnQuietMs?: number;
  crashWindowMs?: number;
  nowMs?: () => number;
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
  private readonly broadcastReplyFn: typeof broadcastReply;
  private readonly unicastFrameFn: typeof unicastFrame;
  private readonly auditFn: typeof appendAudit;
  private readonly processAttachmentsFn: typeof processAttachments;
  private readonly outOfTurnQuietMs: number;
  private readonly crashWindowMs: number;
  private readonly nowMs: () => number;

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
  private cancelRequestedBeforeTurn = false;
  private readonly queue: QueuedTurn[] = [];
  private readonly pendingPermissions: PendingPermission[] = [];
  private openUserChoices = 0;

  private outOfTurnChunks: string[] = [];
  private outOfTurnSessionId: string | null = null;
  private outOfTurnTimer: ReturnType<typeof setTimeout> | null = null;

  private lastListing: AcpSessionInfo[] = [];
  private readonly loadingSessionIds = new Set<string>();
  private readonly instructionsDeliveredSessions = new Set<string>();
  private readonly seenToolCalls = new Map<string, AcpPermissionToolCall>();
  private static readonly MAX_SEEN_TOOL_CALLS = 500;

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
    this.mcpUrl = opts.mcpUrl;
    this.mcpToken = opts.mcpToken;
    this.mcpTransport = opts.mcpTransport ?? "auto";
    this.cliScriptPath =
      opts.cliScriptPath ?? fileURLToPath(new URL("./cli.ts", import.meta.url));
    this.instanceId = opts.instanceId;
    this.onPairingCodeCb = opts.onPairingCode ?? (() => {});
    this.transportFactory = opts.transportFactory ?? spawnAcpTransport;
    this.broadcastReplyFn = opts.broadcastReplyFn ?? broadcastReply;
    this.unicastFrameFn = opts.unicastFrameFn ?? unicastFrame;
    this.auditFn = opts.auditFn ?? appendAudit;
    this.processAttachmentsFn = opts.processAttachmentsFn ?? processAttachments;
    this.outOfTurnQuietMs = opts.outOfTurnQuietMs ?? 3000;
    this.crashWindowMs = opts.crashWindowMs ?? 60_000;
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  getInboundHandlers(): InboundHandlers {
    return {
      onInbound: (input) => this.handleInbound(input),
      onPairingCode: (code) => this.onPairingCodeCb(code),
      onClientOpen: (send) => this.handleClientOpen(send),
    };
  }

  getAttributionSessionId(): string | null {
    return this.runningTurn?.sessionId ?? this.activeSessionId;
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

  onChoicesPresented(): void {
    this.openUserChoices++;
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
      openUserChoices: this.openUserChoices,
      outOfTurnBufferedLength: this.outOfTurnChunks.join("").length,
      lastListingCount: this.lastListing.length,
      restartStopped: this.restartStopped,
    };
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
  ): void {
    this.broadcastReplyFn(text, messageId);
    this.emitReplyAudit(text, acpSessionId);
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

  private handleSessionUpdate(params: AcpSessionUpdateParams): void {
    if (this.loadingSessionIds.has(params.sessionId)) {
      return;
    }

    const update = params.update;
    if (!update || typeof update !== "object") return;

    if (
      (update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update") &&
      typeof update.toolCallId === "string" &&
      update.toolCallId.length > 0
    ) {
      this.recordSeenToolCall(params.sessionId, update.toolCallId, update);
      return;
    }

    if (
      update.sessionUpdate === "session_info_update" &&
      params.sessionId === this.activeSessionId &&
      typeof update.title === "string"
    ) {
      this.activeSessionTitle = update.title;
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
    const choices = options.map((o) => o.name || o.optionId);
    const frame: Record<string, unknown> = {
      type: "choices",
      content: prompt,
      choices,
      multiSelect: false,
      id: `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date(this.nowMs()).toISOString(),
    };

    const pending: PendingPermission = {
      rpcId,
      sessionId,
      toolName,
      promptHash,
      frame,
      options,
      resolved: false,
    };
    this.pendingPermissions.push(pending);
    this.unicastFrameFn(frame);
  }

  private cancelAllPendingPermissions(respondToClient: boolean): number {
    let count = 0;
    while (this.pendingPermissions.length > 0) {
      const perm = this.pendingPermissions.shift()!;
      if (perm.resolved) continue;
      perm.resolved = true;
      count++;
      if (respondToClient && this.client && !this.client.isClosed) {
        this.client.respond(perm.rpcId, { outcome: { outcome: "cancelled" } });
      }
      this.emitPermissionAudit(
        perm.toolName,
        "cancelled",
        perm.promptHash,
        perm.sessionId || this.activeSessionId,
      );
    }
    return count;
  }

  private handleHarnessExit(
    exitedClient: AcpClient,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.client === exitedClient) {
      this.client = null;
    }
    if (this.shuttingDown) return;

    this.cancelAllPendingPermissions(false);
    this.flushOutOfTurnBuffer();

    const prevSessionId = this.activeSessionId;
    this.runningTurn = null;
    this.turnBusy = false;
    this.activeSessionId = null;
    this.activeSessionCwd = null;
    this.activeSessionTitle = null;
    this.openUserChoices = 0;
    this.seenToolCalls.clear();
    this.instructionsDeliveredSessions.clear();

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
      return;
    }

    this.sendStandaloneReply(
      `⚠ Harness ${this.harness.name} exited unexpectedly (${exitDetail}). Restarting automatically — use /sessions and /resume to continue.`,
      prevSessionId,
    );

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

  /**
   * Normative inbound routing order (SPEC-HC-005 §4.1):
   * 1. Pairing is handled outside via `onPairingCode`.
   * 2. Recognised slash command.
   * 3. Pending permission on the active session.
   * 4. `choice_response` with no pending permission (openUserChoices guard).
   * 5. Turn running -> FIFO queue.
   * 6. Dispatch as `session/prompt` (auto-creating a session if none exists).
   */
  async handleInbound(
    input: InboundMessage,
  ): Promise<{ acpSessionId?: string | null }> {
    const metaType =
      typeof input.meta.type === "string" ? input.meta.type : undefined;
    const isChoiceResponse = metaType === "choice_response";
    const isQuestionsBatchResponse = metaType === "questions_batch_response";

    // Step 2: Slash commands (plain text only)
    if (!isChoiceResponse && !isQuestionsBatchResponse) {
      const cmd = this.parseRecognisedSlashCommand(input.text);
      if (cmd) {
        return this.handleSlashCommand(cmd.name, cmd.argsText);
      }
    }

    // Step 3: Pending permission on active session
    if (this.pendingPermissions.length > 0) {
      const oldest = this.pendingPermissions[0]!;
      const matchedOpt = this.matchPermissionOption(oldest, input);
      if (matchedOpt && !oldest.resolved) {
        this.pendingPermissions.shift();
        oldest.resolved = true;
        if (this.client && !this.client.isClosed) {
          this.client.respond(oldest.rpcId, {
            outcome: { outcome: "selected", optionId: matchedOpt.optionId },
          });
        }
        const approval = matchedOpt.kind.startsWith("reject")
          ? "user_denied"
          : "user_approved";
        this.emitPermissionAudit(
          oldest.toolName,
          approval,
          oldest.promptHash,
          oldest.sessionId || this.activeSessionId,
        );
        return { acpSessionId: oldest.sessionId || this.activeSessionId };
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
      return { acpSessionId: this.activeSessionId };
    }

    // Step 4: `choice_response` with no pending permission
    if (isChoiceResponse) {
      if (this.openUserChoices > 0) {
        this.openUserChoices--;
      } else {
        this.sendStandaloneReply("no pending approval", this.activeSessionId);
        return { acpSessionId: this.activeSessionId };
      }
    }

    // Step 5: Turn running or session switch in flight? Queue FIFO
    if (this.turnBusy || this.sessionOpInFlight) {
      this.queue.push({ input, isChoiceResponse });
      this.sendStandaloneReply(
        `⏳ queued (${this.queue.length} ahead)`,
        this.activeSessionId,
      );
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
      const cancelledPerms = this.cancelAllPendingPermissions(true);
      if (this.runningTurn && this.client && !this.client.isClosed) {
        this.runningTurn.cancelledByCommand = true;
        this.client.sessionCancel(this.runningTurn.sessionId);
        return { acpSessionId: this.runningTurn.sessionId };
      }
      if (this.turnBusy) {
        this.cancelRequestedBeforeTurn = true;
        return { acpSessionId: this.activeSessionId };
      }
      if (cancelledPerms > 0) {
        this.sendStandaloneReply("⏹ cancelled", this.activeSessionId);
      } else {
        this.sendStandaloneReply("nothing running", this.activeSessionId);
      }
      return { acpSessionId: this.activeSessionId };
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
        const res = await client.sessionNew({
          cwd: absCwd,
          mcpServers: [this.buildMcpServer()],
          ...this.buildSessionInitExtensions(),
        });
        this.activeSessionId = res.sessionId;
        this.activeSessionCwd = absCwd;
        this.activeSessionTitle = null;
        this.openUserChoices = 0;
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
        const sorted = [...(res.sessions ?? [])].sort((a, b) => {
          const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
          const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
          return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
        });

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
          resolved = listRes.sessions?.find((s) => s.sessionId === target);
        }

        const sessionId = resolved?.sessionId ?? target;
        const cwd = resolved?.cwd || this.defaultCwd;
        const title = resolved?.title?.trim() || sessionId;

        this.flushOutOfTurnBuffer();
        const supportsResume = Boolean(
          this.agentCapabilities.sessionCapabilities?.resume,
        );
        const resumeParams = {
          sessionId,
          cwd,
          mcpServers: [this.buildMcpServer(sessionId)],
          ...this.buildSessionInitExtensions(),
        };
        // Suppress history replay notifications emitted synchronously during both
        // session/load and session/resume (Hermes streams replay inside resume_session).
        this.loadingSessionIds.add(sessionId);
        try {
          if (supportsResume) {
            await client.sessionResume(resumeParams);
          } else {
            await client.sessionLoad(resumeParams);
          }
        } finally {
          this.loadingSessionIds.delete(sessionId);
        }

        this.activeSessionId = sessionId;
        this.activeSessionCwd = cwd;
        this.activeSessionTitle = resolved?.title ?? null;
        this.openUserChoices = 0;
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
      this.openUserChoices = 0;
    }
    let client: AcpClient;
    let sessionId: string;

    try {
      client = await this.ensureClient();
      if (!this.activeSessionId) {
        const res = await client.sessionNew({
          cwd: this.defaultCwd,
          mcpServers: [this.buildMcpServer()],
          ...this.buildSessionInitExtensions(),
        });
        this.activeSessionId = res.sessionId;
        this.activeSessionCwd = this.defaultCwd;
        this.activeSessionTitle = null;
        this.openUserChoices = 0;
        this.sendStandaloneReply(
          `▶ Auto-created ${this.harness.name} session in \`${this.defaultCwd}\` (id ${res.sessionId})`,
          res.sessionId,
        );
      }
      sessionId = this.activeSessionId;
    } catch (err) {
      this.turnBusy = false;
      this.cancelRequestedBeforeTurn = false;
      this.sendStandaloneReply(
        `Failed to start ${this.harness.name} session: ${
          err instanceof Error ? err.message : err
        }`,
        this.activeSessionId,
      );
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
      sessionId,
      chunks: [],
      delegationMessageId,
      clientMessageId,
      replyToolCalled: false,
      cancelledByCommand: this.cancelRequestedBeforeTurn,
    };
    this.cancelRequestedBeforeTurn = false;
    this.runningTurn = turn;

    if (turn.cancelledByCommand) {
      this.runningTurn = null;
      this.turnBusy = false;
      const targetMsgId = turn.delegationMessageId ?? turn.clientMessageId ?? undefined;
      this.sendStandaloneReply("⏹ cancelled", sessionId, targetMsgId);
      void this.drainQueue();
      return { acpSessionId: sessionId };
    }

    void this.executeTurn(client, turn, item.input);
    return { acpSessionId: sessionId };
  }

  private async executeTurn(
    client: AcpClient,
    turn: RunningTurn,
    input: InboundMessage,
  ): Promise<void> {
    try {
      let promptBlocks = await this.buildPromptBlocks(input);
      if (turn.cancelledByCommand) {
        const targetMsgId =
          turn.delegationMessageId ?? turn.clientMessageId ?? undefined;
        this.sendStandaloneReply("⏹ cancelled", turn.sessionId, targetMsgId);
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

      const targetMsgId =
        turn.delegationMessageId ?? turn.clientMessageId ?? undefined;
      const collected = turn.chunks.join("");

      if (turn.cancelledByCommand) {
        this.sendStandaloneReply("⏹ cancelled", turn.sessionId, targetMsgId);
      } else if (collected.length > 0) {
        this.sendStandaloneReply(collected, turn.sessionId, targetMsgId);
      } else if (
        turn.delegationMessageId !== null ||
        result.stopReason !== "end_turn" ||
        !turn.replyToolCalled
      ) {
        const fallbackText = `(no text output — stopReason: ${result.stopReason})`;
        this.sendStandaloneReply(fallbackText, turn.sessionId, targetMsgId);
      }
      // Else: non-delegation end_turn where agent already called reply_to_hitl; emit no extra reply.
    } catch (err) {
      // If client closed due to crash/shutdown, handleHarnessExit / shutdown already notified cleanly.
      if (!client.isClosed && !this.shuttingDown) {
        const targetMsgId =
          turn.delegationMessageId ?? turn.clientMessageId ?? undefined;
        const msg = err instanceof Error ? err.message : String(err);
        this.sendStandaloneReply(`⚠ Turn error: ${msg}`, turn.sessionId, targetMsgId);
      }
    } finally {
      if (this.runningTurn === turn) {
        this.runningTurn = null;
        this.turnBusy = false;
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

    if (this.outOfTurnTimer) {
      clearTimeout(this.outOfTurnTimer);
      this.outOfTurnTimer = null;
    }

    this.cancelAllPendingPermissions(true);
    this.queue.length = 0;
    this.seenToolCalls.clear();
    this.instructionsDeliveredSessions.clear();

    const toClose = this.client ?? this.pendingClient;
    if (toClose) {
      await toClose.close();
      this.client = null;
      this.pendingClient = null;
    }
    if (this.startPromise) {
      await this.startPromise.catch(() => {});
    }
  }
}
