import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
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

export interface HarnessDefinition {
  name: string;
  command: string;
  args: string[];
  mcpServerName: string;
  autoAllowPrefixes: string[];
  buildSystemPromptMeta(instructions: string): Record<string, unknown>;
}

export const HARNESS_REGISTRY: Record<string, HarnessDefinition> = {
  agy: {
    name: "agy",
    command: "agy",
    args: ["acp"],
    mcpServerName: "hitl-channel",
    autoAllowPrefixes: ["mcp_hitl-channel_"],
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
};

/**
 * Fail-closed check for whether a `session/request_permission` belongs to the
 * daemon's own injected HITL MCP tools (which the phone already gates with its
 * trust-tier sheets).
 */
export function isOwnHitlTool(
  toolCall: AcpPermissionToolCall,
  autoAllowPrefixes: string[],
): boolean {
  const name = typeof toolCall.name === "string" ? toolCall.name : "";
  if (name.length > 0) {
    return autoAllowPrefixes.some((prefix) => name.startsWith(prefix));
  }
  const title = typeof toolCall.title === "string" ? toolCall.title : "";
  if (title.length > 0) {
    return autoAllowPrefixes.some((prefix) => title.startsWith(`Run ${prefix}`));
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

function deriveToolName(toolCall: AcpPermissionToolCall): string {
  if (typeof toolCall.name === "string" && toolCall.name.trim().length > 0) {
    return toolCall.name.trim();
  }
  if (typeof toolCall.title === "string" && toolCall.title.trim().length > 0) {
    const title = toolCall.title.trim();
    return title.startsWith("Run ") ? title.slice(4).trim() : title;
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

function formatPermissionPrompt(toolCall: AcpPermissionToolCall): string {
  const title =
    typeof toolCall.title === "string" && toolCall.title.trim().length > 0
      ? toolCall.title.trim()
      : deriveToolName(toolCall);
  const inputSummary = oneLineSummary(toolCall.rawInput);
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
  private startPromise: Promise<AcpClient> | null = null;
  private agentCapabilities: AcpAgentCapabilities = {};

  private activeSessionId: string | null = null;
  private activeSessionCwd: string | null = null;
  private activeSessionTitle: string | null = null;

  private turnBusy = false;
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

  private buildMcpServer(): AcpMcpServer {
    return {
      type: "http",
      name: this.harness.mcpServerName,
      url: this.mcpUrl,
      headers: [{ name: "Authorization", value: `Bearer ${this.mcpToken}` }],
    };
  }

  private buildSessionMeta(): Record<string, unknown> {
    return this.harness.buildSystemPromptMeta(DAEMON_INSTRUCTIONS);
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
      const transport = this.transportFactory(
        this.harness.command,
        this.harness.args,
        { cwd: this.defaultCwd },
      );
      const client = new AcpClient(transport);
      client.onSessionUpdate((params) => this.handleSessionUpdate(params));
      client.onPermissionRequest((id, params) =>
        this.handlePermissionRequest(client, id, params),
      );
      client.onExit((code, signal) => this.handleHarnessExit(client, code, signal));

      try {
        const initRes = await client.initialize();
        this.agentCapabilities = initRes.agentCapabilities ?? {};
        this.client = client;
        return client;
      } catch (err) {
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

  private handleSessionUpdate(params: AcpSessionUpdateParams): void {
    if (this.loadingSessionIds.has(params.sessionId)) {
      return;
    }

    const update = params.update;
    if (!update || typeof update !== "object") return;

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
    const toolName = deriveToolName(toolCall);
    const promptHash = sha256Hex(stableStringify(toolCall.rawInput ?? null));
    const sessionId = params.sessionId ?? this.activeSessionId ?? "";

    if (isOwnHitlTool(toolCall, this.harness.autoAllowPrefixes)) {
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

    const prompt = formatPermissionPrompt(toolCall);
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

    // Step 5: Turn running? Queue FIFO
    if (this.turnBusy) {
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

  private async handleSlashCommand(
    cmd: string,
    argsText: string,
  ): Promise<{ acpSessionId?: string | null }> {
    if (cmd === "/help") {
      const helpText = [
        "Available commands:",
        "- /help — show this command list",
        "- /new [harness] [cwd] — start a new session (Phase 1 harness: agy)",
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
      if (this.turnBusy) {
        this.sendStandaloneReply(
          "⚠ A turn is currently running — send /cancel first",
          this.activeSessionId,
        );
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
          `Unsupported harness '${targetHarness}'. Phase 1 only supports '${this.harness.name}'.`,
          this.activeSessionId,
        );
        return { acpSessionId: this.activeSessionId };
      }

      const absCwd = expandHomeAndResolve(rawCwd, this.defaultCwd);
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

      try {
        const client = await this.ensureClient();
        this.flushOutOfTurnBuffer();
        const res = await client.sessionNew({
          cwd: absCwd,
          mcpServers: [this.buildMcpServer()],
          _meta: this.buildSessionMeta(),
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
      if (this.turnBusy) {
        this.sendStandaloneReply(
          "⚠ A turn is currently running — send /cancel first",
          this.activeSessionId,
        );
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
        if (supportsResume) {
          await client.sessionResume({
            sessionId,
            cwd,
            mcpServers: [this.buildMcpServer()],
            _meta: this.buildSessionMeta(),
          });
        } else {
          this.loadingSessionIds.add(sessionId);
          try {
            await client.sessionLoad({
              sessionId,
              cwd,
              mcpServers: [this.buildMcpServer()],
              _meta: this.buildSessionMeta(),
            });
          } finally {
            this.loadingSessionIds.delete(sessionId);
          }
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
      }
    }

    return { acpSessionId: this.activeSessionId };
  }

  private async startTurn(item: QueuedTurn): Promise<{ acpSessionId?: string | null }> {
    this.turnBusy = true;
    this.cancelRequestedBeforeTurn = false;
    let client: AcpClient;
    let sessionId: string;

    try {
      client = await this.ensureClient();
      if (!this.activeSessionId) {
        const res = await client.sessionNew({
          cwd: this.defaultCwd,
          mcpServers: [this.buildMcpServer()],
          _meta: this.buildSessionMeta(),
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

    if (!item.isChoiceResponse) {
      this.openUserChoices = 0;
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
      const promptBlocks = await this.buildPromptBlocks(input);
      if (turn.cancelledByCommand) {
        const targetMsgId =
          turn.delegationMessageId ?? turn.clientMessageId ?? undefined;
        this.sendStandaloneReply("⏹ cancelled", turn.sessionId, targetMsgId);
        return;
      }

      const result = await client.sessionPrompt({
        sessionId: turn.sessionId,
        prompt: promptBlocks,
      });

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
    if (this.turnBusy || this.pendingPermissions.length > 0 || this.shuttingDown) {
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

    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}
