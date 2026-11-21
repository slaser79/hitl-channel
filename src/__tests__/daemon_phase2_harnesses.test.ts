import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { hostname as osHostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAcpTransport } from "../acp_client.js";
import {
  AcpSessionManager,
  HARNESS_REGISTRY,
  isOwnHitlTool,
  resolveHarnessLaunch,
} from "../acp_session_manager.js";
import { auditDir, type AuditEvent } from "../audit.js";
import { parseDaemonArgs, startDaemon, type DaemonHandle } from "../daemon.js";
import { replyBuffer } from "../http_bridge.js";
import { DAEMON_INSTRUCTIONS } from "../mcp_instructions.js";

const FAKE_PHASE2_AGENT_PATH = join(
  import.meta.dir,
  "fixtures",
  "fake_phase2_acp_agent.ts",
);

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timed out waiting for predicate");
}

function readLog(logFile: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function readAuditEvents(instanceId: string): AuditEvent[] {
  try {
    const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
    return files
      .flatMap((f) => readFileSync(join(auditDir, f), "utf8").trim().split("\n"))
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEvent)
      .filter((e) => e.instance_id === instanceId);
  } catch {
    return [];
  }
}

describe("SPEC-HC-005 Phase 2 harnesses, registry, launch & correlation", () => {
  it("HARNESS_REGISTRY exposes agy (8790), codex (8791), hermes (8792)", () => {
    expect(HARNESS_REGISTRY.agy?.defaultPort).toBe(8790);
    expect(HARNESS_REGISTRY.agy?.autoAllowPrefixes).toEqual(["mcp_hitl-channel_"]);
    expect(HARNESS_REGISTRY.agy?.matchBareTitlePrefix).toBe(false);
    expect(HARNESS_REGISTRY.agy?.systemPromptStrategy).toBe("agy_meta");

    expect(HARNESS_REGISTRY.codex?.defaultPort).toBe(8791);
    expect(HARNESS_REGISTRY.codex?.autoAllowPrefixes).toEqual(["mcp.hitl-channel."]);
    expect(HARNESS_REGISTRY.codex?.matchBareTitlePrefix).toBe(true);
    expect(HARNESS_REGISTRY.codex?.systemPromptStrategy).toBe("acp_system_prompt");

    expect(HARNESS_REGISTRY.hermes?.defaultPort).toBe(8792);
    expect(HARNESS_REGISTRY.hermes?.autoAllowPrefixes).toEqual([
      "mcp__hitl_channel__",
    ]);
    expect(HARNESS_REGISTRY.hermes?.matchBareTitlePrefix).toBe(true);
    expect(HARNESS_REGISTRY.hermes?.systemPromptStrategy).toBe(
      "first_prompt_prefix",
    );
  });

  it("resolveHarnessLaunch honors env override, direct PATH hit, and fallback command", () => {
    const codex = HARNESS_REGISTRY.codex!;
    expect(
      resolveHarnessLaunch(codex, { HITL_CODEX_ACP_BIN: "/custom/codex-acp" }, () => null),
    ).toEqual({ command: "/custom/codex-acp", args: [] });

    // Empty env var falls back cleanly
    expect(
      resolveHarnessLaunch(codex, { HITL_CODEX_ACP_BIN: "   " }, () => null),
    ).toEqual({ command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] });

    expect(
      resolveHarnessLaunch(codex, {}, (cmd) =>
        cmd === "codex-acp" ? "/usr/local/bin/codex-acp" : null,
      ),
    ).toEqual({ command: "codex-acp", args: [] });

    expect(
      resolveHarnessLaunch(HARNESS_REGISTRY.hermes!, { HITL_HERMES_BIN: "/opt/hermes" }),
    ).toEqual({ command: "/opt/hermes", args: ["acp"] });
  });

  it("parseDaemonArgs resolves per-harness default ports regardless of flag order and validates --mcp-transport", () => {
    const prevPort = process.env.HITL_CHANNEL_PORT;
    const prevTransport = process.env.HITL_MCP_TRANSPORT;
    delete process.env.HITL_CHANNEL_PORT;
    delete process.env.HITL_MCP_TRANSPORT;
    try {
      expect(parseDaemonArgs(["--harness", "agy"]).port).toBe(8790);
      expect(parseDaemonArgs(["--harness", "codex"]).port).toBe(8791);
      expect(parseDaemonArgs(["--harness", "hermes"]).port).toBe(8792);
      expect(parseDaemonArgs(["--port", "9999", "--harness", "codex"]).port).toBe(
        9999,
      );
      expect(
        parseDaemonArgs(["--harness", "hermes", "--mcp-transport", "stdio"])
          .mcpTransport,
      ).toBe("stdio");

      process.env.HITL_MCP_TRANSPORT = "http";
      expect(parseDaemonArgs(["--harness", "codex"]).mcpTransport).toBe("http");

      expect(() =>
        parseDaemonArgs(["--mcp-transport", "websocket"]),
      ).toThrow(/Invalid --mcp-transport/);
    } finally {
      if (prevPort !== undefined) process.env.HITL_CHANNEL_PORT = prevPort;
      else delete process.env.HITL_CHANNEL_PORT;
      if (prevTransport !== undefined)
        process.env.HITL_MCP_TRANSPORT = prevTransport;
      else delete process.env.HITL_MCP_TRANSPORT;
    }
  });

  it("isOwnHitlTool preserves fail-closed agy rules and safely correlates Codex/Hermes toolCallId", () => {
    // Phase 1 2-arg call: Run prefix matches, bare agy title stays false
    expect(
      isOwnHitlTool({ name: "mcp_hitl-channel_call_phone_tool" }, [
        "mcp_hitl-channel_",
      ]),
    ).toBe(true);
    expect(
      isOwnHitlTool({ title: "Run mcp_hitl-channel_push_file" }, [
        "mcp_hitl-channel_",
      ]),
    ).toBe(true);
    expect(
      isOwnHitlTool({ title: "mcp_hitl-channel_push_file" }, [
        "mcp_hitl-channel_",
      ]),
    ).toBe(false);

    // Correlated Codex bare permission ({ toolCallId, kind }) uses seen tool_call title
    expect(
      isOwnHitlTool(
        { toolCallId: "tc-1", kind: "execute" },
        ["mcp.hitl-channel."],
        {
          matchBareTitlePrefix: true,
          correlatedToolCall: {
            toolCallId: "tc-1",
            title: "mcp.hitl-channel.call_phone_tool",
            rawInput: { server: "hitl-channel", tool: "call_phone_tool", arguments: {} },
          },
        },
      ),
    ).toBe(true);

    // Rejects shell commands attempting bare title prefix match when rawInput.command is string
    expect(
      isOwnHitlTool(
        { toolCallId: "tc-2", kind: "execute" },
        ["mcp.hitl-channel."],
        {
          matchBareTitlePrefix: true,
          correlatedToolCall: {
            toolCallId: "tc-2",
            title: "mcp.hitl-channel.spoofed",
            rawInput: { command: "rm -rf /" },
          },
        },
      ),
    ).toBe(false);

    // Explicit non-matching title/name is fail-closed even when correlated entry matches
    expect(
      isOwnHitlTool(
        { toolCallId: "tc-3", title: "Run echo pwned" },
        ["mcp.hitl-channel."],
        {
          matchBareTitlePrefix: true,
          correlatedToolCall: {
            toolCallId: "tc-3",
            title: "mcp.hitl-channel.call_phone_tool",
          },
        },
      ),
    ).toBe(false);

    // Hermes sanitized mcp__hitl_channel__ bare title match
    expect(
      isOwnHitlTool(
        { toolCallId: "h-1", title: "mcp__hitl_channel__list_phone_tools" },
        ["mcp__hitl_channel__"],
        { matchBareTitlePrefix: true },
      ),
    ).toBe(true);
  });
});

describe("SPEC-HC-005 Phase 2 Integration (Codex, Hermes, stdio mcp-shim)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  function setupEnv() {
    const dir = mkdtempSync(join(tmpdir(), "hitl-p2-int-"));
    const prev = {
      HOME: process.env.HOME,
      HITL_CHANNEL_IDENTITY_FILE: process.env.HITL_CHANNEL_IDENTITY_FILE,
      HITL_CHANNEL_NAME: process.env.HITL_CHANNEL_NAME,
      HITL_INSTANCE_ID: process.env.HITL_INSTANCE_ID,
      HITL_CHANNEL_API_KEY: process.env.HITL_CHANNEL_API_KEY,
    };
    process.env.HOME = dir;
    process.env.HITL_CHANNEL_API_KEY = "phase2-key";
    delete process.env.HITL_CHANNEL_IDENTITY_FILE;
    delete process.env.HITL_CHANNEL_NAME;
    delete process.env.HITL_INSTANCE_ID;

    cleanups.push(() => {
      process.env.HOME = prev.HOME;
      if (prev.HITL_CHANNEL_IDENTITY_FILE !== undefined)
        process.env.HITL_CHANNEL_IDENTITY_FILE = prev.HITL_CHANNEL_IDENTITY_FILE;
      else delete process.env.HITL_CHANNEL_IDENTITY_FILE;
      if (prev.HITL_CHANNEL_NAME !== undefined)
        process.env.HITL_CHANNEL_NAME = prev.HITL_CHANNEL_NAME;
      else delete process.env.HITL_CHANNEL_NAME;
      if (prev.HITL_INSTANCE_ID !== undefined)
        process.env.HITL_INSTANCE_ID = prev.HITL_INSTANCE_ID;
      else delete process.env.HITL_INSTANCE_ID;
      if (prev.HITL_CHANNEL_API_KEY !== undefined)
        process.env.HITL_CHANNEL_API_KEY = prev.HITL_CHANNEL_API_KEY;
      else delete process.env.HITL_CHANNEL_API_KEY;
      replyBuffer.drain();
      rmSync(dir, { recursive: true, force: true });
    });

    return dir;
  }

  async function bootFakeHarnessDaemon(
    dir: string,
    harness: "agy" | "codex" | "hermes",
    profile: "codex" | "hermes" | "stdio_only",
    extraOpts?: Partial<Parameters<typeof startDaemon>[0]>,
    extraFakeEnv?: Record<string, string>,
  ) {
    const logFile = join(dir, `${profile}.log`);
    const daemon: DaemonHandle = await startDaemon({
      harness,
      port: 0,
      cwd: dir,
      enableMdns: false,
      enableDesktopNotifications: false,
      ...extraOpts,
      transportFactory: (_cmd, _args, opts) =>
        spawnAcpTransport(process.execPath, ["run", FAKE_PHASE2_AGENT_PATH], {
          cwd: opts?.cwd,
          env: {
            FAKE_ACP_LOG_FILE: logFile,
            FAKE_HARNESS_PROFILE: profile,
            ...(extraFakeEnv ?? {}),
          },
        }),
    });
    cleanups.push(() => daemon.shutdown());

    const replies: Array<{ id?: string; text: string }> = [];
    const choicesFrames: Array<Record<string, unknown>> = [];
    const toolCalls: Array<Record<string, unknown>> = [];

    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws?token=phase2-key`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws failed")));
    });
    cleanups.push(() => ws.close());

    ws.addEventListener("message", (evt) => {
      const frame = JSON.parse(String(evt.data)) as Record<string, unknown>;
      if (frame.type === "reply") {
        if (frame.id) ws.send(JSON.stringify({ type: "ack", id: frame.id }));
        replies.push({ id: frame.id as string | undefined, text: String(frame.text) });
      } else if (frame.type === "choices") {
        choicesFrames.push(frame);
      } else if (frame.type === "tool_call_request") {
        toolCalls.push(frame);
        ws.send(
          JSON.stringify({
            type: "tool_call_result",
            request_id: frame.request_id,
            success: true,
            approval: "auto",
            output: `PHONE_OK:${frame.name}`,
          }),
        );
      }
    });

    const post = async (body: Record<string, unknown>) => {
      const r = await fetch(`http://127.0.0.1:${daemon.port}/`, {
        method: "POST",
        headers: {
          authorization: "Bearer phase2-key",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(200);
    };

    return { daemon, logFile, replies, choicesFrames, toolCalls, post };
  }

  it("codex profile: identity, top-level systemPrompt, HTTP MCP + toolCallId auto-allow, fallback audit sessionId, and Yes/Decline choices", async () => {
    const dir = setupEnv();
    const { daemon, logFile, replies, choicesFrames, toolCalls, post } =
      await bootFakeHarnessDaemon(dir, "codex", "codex");

    expect(daemon.displayName).toBe(`codex@${osHostname()}`);
    expect(
      readFileSync(join(dir, ".hitl", "channels", "identity-daemon-codex.json"), "utf8"),
    ).toContain(daemon.instanceId);

    // 1. Auto-creates codex session with top-level systemPrompt, invokes HTTP MCP hitl tool
    //    correlated via toolCallId (0 choices frames sent to phone!), and attributes audit.
    await post({ message: "run hitl_tool" });
    await waitFor(() => replies.some((r) => r.text === "TOOL_OK:PHONE_OK:ping"));
    expect(choicesFrames.length).toBe(0);
    expect(toolCalls.map((t) => t.name)).toEqual(["ping"]);

    const events = readLog(logFile);
    const snew = events.find((e) => e.event === "session_new");
    expect((snew?.mcpServers as Array<Record<string, unknown>>)?.[0]?.type).toBe(
      "http",
    );
    expect(snew?.systemPrompt).toEqual({
      mode: "append",
      content: [{ type: "text", text: DAEMON_INSTRUCTIONS }],
    });
    expect(snew?._meta).toBeNull();

    let permAuto: AuditEvent | undefined;
    let phoneCallAudit: AuditEvent | undefined;
    await waitFor(() => {
      const audits = readAuditEvents(daemon.instanceId);
      permAuto = audits.find(
        (a) => a.kind === "permission" && a.approval === "auto",
      );
      phoneCallAudit = audits.find(
        (a) => a.kind === "tool_call" && a.tool_name === "ping",
      );
      return Boolean(permAuto && phoneCallAudit);
    });
    expect(permAuto?.tool_name).toBe("mcp.hitl-channel.call_phone_tool");
    expect(permAuto?.acp_session_id).toBe("codex-sess-1");
    // call_phone_tool didn't pass antigravity meta, so loopback fallback supplied codex-sess-1!
    expect(phoneCallAudit?.acp_session_id).toBe("codex-sess-1");

    // 2. Non-HITL shell permission presents Codex 'Yes, proceed' option & executes when selected
    await post({ message: "run shell command" });
    await waitFor(() => choicesFrames.length === 1);
    expect(choicesFrames[0]?.choices).toEqual([
      "Yes, proceed",
      "No, continue without running it",
    ]);
    await post({
      type: "choice_response",
      content: "Yes, proceed",
      selections: ["Yes, proceed"],
    });
    await waitFor(() => replies.some((r) => r.text === "SHELL_DECISION:accept"));

    // 3. /new hermes on codex daemon preserves 'Unsupported harness'
    await post({ message: "/new hermes" });
    await waitFor(() =>
      replies.some((r) => r.text.includes("Unsupported harness")),
    );
  });

  it("hermes profile: first_prompt_prefix injected once per session, session/resume suppresses replay, mcp__hitl_channel__ auto-allows", async () => {
    const dir = setupEnv();
    const { daemon, logFile, replies, choicesFrames, post } =
      await bootFakeHarnessDaemon(dir, "hermes", "hermes");

    expect(daemon.displayName).toBe(`hermes@${osHostname()}`);

    // Turn 1: injects <system_instructions> block once and auto-allows mcp__hitl_channel__
    await post({ message: "run hitl_tool" });
    await waitFor(() => replies.some((r) => r.text === "TOOL_OK:PHONE_OK:ping"));
    expect(choicesFrames.length).toBe(0);

    // Turn 2: does NOT re-inject <system_instructions>
    await post({ message: "plain second turn" });
    await waitFor(() =>
      replies.some((r) => r.text === "ECHO:plain second turn"),
    );

    const promptEvents = readLog(logFile).filter((e) => e.event === "session_prompt");
    expect(promptEvents.length).toBe(2);
    const turn1Blocks = promptEvents[0]!.promptBlocks as Array<{ text: string }>;
    const turn2Blocks = promptEvents[1]!.promptBlocks as Array<{ text: string }>;
    expect(turn1Blocks[0]?.text).toContain("<system_instructions>");
    expect(turn1Blocks[0]?.text).toContain(DAEMON_INSTRUCTIONS);
    expect(turn1Blocks[1]?.text).toBe("run hitl_tool");
    expect(turn2Blocks.length).toBe(1);
    expect(turn2Blocks[0]?.text).toBe("plain second turn");

    // session/resume suppresses synchronous HISTORICAL_REPLAY_CHUNK + replay tool_call!
    await post({ message: "/sessions" });
    await waitFor(() =>
      replies.some((r) => r.text.includes("Initial hermes title")),
    );
    await post({ message: "/resume hermes-sess-1" });
    await waitFor(() =>
      replies.some((r) => r.text.includes("Resumed `Initial hermes title`")),
    );

    // Flush any quiet buffer by sending a command and ensuring HISTORICAL_REPLAY_CHUNK never arrives
    await post({ message: "/status" });
    await waitFor(() => replies.some((r) => r.text.includes("Harness: hermes")));
    await new Promise((r) => setTimeout(r, 80));
    expect(replies.some((r) => r.text.includes("HISTORICAL_REPLAY_CHUNK"))).toBe(
      false,
    );

    // Shell permission on Hermes uses Allow once -> executes
    await post({ message: "run shell" });
    await waitFor(() => choicesFrames.length === 1);
    await post({
      type: "choice_response",
      content: "Allow once",
      selections: ["Allow once"],
    });
    await waitFor(() =>
      replies.some((r) => r.text === "SHELL_DECISION:allow_once"),
    );
  });

  it("hermes upgrades to top-level systemPrompt when sessionCapabilities.systemPrompt is advertised", async () => {
    const dir = setupEnv();
    const { logFile, replies, post } = await bootFakeHarnessDaemon(
      dir,
      "hermes",
      "hermes",
      {},
      { FAKE_HERMES_CAP_SYS_PROMPT: "1" },
    );

    await post({ message: "hello dynamic cap" });
    await waitFor(() =>
      replies.some((r) => r.text === "ECHO:hello dynamic cap"),
    );

    const events = readLog(logFile);
    const snew = events.find((e) => e.event === "session_new");
    expect(snew?.systemPrompt).toEqual({
      mode: "append",
      content: [{ type: "text", text: DAEMON_INSTRUCTIONS }],
    });
    const promptEvt = events.find((e) => e.event === "session_prompt");
    const blocks = promptEvt!.promptBlocks as Array<{ text: string }>;
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.text).toBe("hello dynamic cap");
  });

  it("stdio_only capability triggers automatic mcp-shim fallback end-to-end", async () => {
    const dir = setupEnv();
    const { logFile, replies, toolCalls, post } = await bootFakeHarnessDaemon(
      dir,
      "codex",
      "stdio_only",
      { mcpTransport: "auto" },
    );

    await post({ message: "run hitl_tool" });
    await waitFor(() => replies.some((r) => r.text === "TOOL_OK:PHONE_OK:ping"));
    expect(toolCalls.map((t) => t.name)).toEqual(["ping"]);

    const events = readLog(logFile);
    const snew = events.find((e) => e.event === "session_new");
    const mcp = (snew?.mcpServers as Array<Record<string, unknown>>)?.[0];
    expect("type" in (mcp ?? {})).toBe(false);
    expect(mcp?.command).toBe(process.execPath);
    const args = mcp?.args as string[];
    expect(args[0]).toBe("run");
    expect(args[2]).toBe("mcp-shim");
    expect(args.join(" ")).not.toContain("phase2"); // bearer token stays in env, not argv
    const envPairs = mcp?.env as Array<{ name: string; value: string }>;
    expect(envPairs.some((e) => e.name === "HITL_MCP_SHIM_TOKEN" && e.value.length > 0)).toBe(
      true,
    );

    const toolsListEvt = events.find((e) => e.event === "stdio_mcp_tools_list");
    expect(toolsListEvt?.toolNames as string[]).toContain("call_phone_tool");
  });

  it("cross-session toolCallId isolation: session-B permission cannot inherit session-A tool_call correlation", async () => {
    const lineCbs: Array<(line: string) => void> = [];
    const closeCbs: Array<(c: number | null, s: NodeJS.Signals | null) => void> = [];
    const sent: Array<Record<string, unknown>> = [];
    const replies: Array<{ text: string }> = [];
    const choices: Array<Record<string, unknown>> = [];

    const transport = {
      pid: 99999,
      send(line: string) {
        const msg = JSON.parse(line) as Record<string, unknown>;
        sent.push(msg);
        if (msg.method === "initialize") {
          for (const cb of lineCbs) {
            cb(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: { protocolVersion: 1, agentCapabilities: {} },
              }),
            );
          }
        }
      },
      onLine(cb: (line: string) => void) {
        lineCbs.push(cb);
      },
      onClose(cb: (c: number | null, s: NodeJS.Signals | null) => void) {
        closeCbs.push(cb);
      },
      async close() {},
    };

    const manager = new AcpSessionManager({
      harness: "codex",
      defaultCwd: "/tmp",
      mcpUrl: "http://127.0.0.1:45555/mcp",
      mcpToken: "tok",
      instanceId: "inst-cross-sess",
      transportFactory: () => transport,
      broadcastReplyFn: (text) => replies.push({ text }),
      unicastFrameFn: (frame) => {
        choices.push(frame);
        return { delivered: true, targetDevice: "dev-1" };
      },
      auditFn: async () => {},
    });

    await manager.start();
    const emitLine = (obj: Record<string, unknown>) => {
      const s = JSON.stringify(obj);
      for (const cb of lineCbs) cb(s);
    };

    // session-A records toolCallId "shared-1" as a HITL tool
    emitLine({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-A",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "shared-1",
          title: "mcp.hitl-channel.list_phone_tools",
          kind: "other",
        },
      },
    });

    // session-B sends a permission with the SAME toolCallId "shared-1" and no name/title -> must fail closed!
    emitLine({
      jsonrpc: "2.0",
      id: 700,
      method: "session/request_permission",
      params: {
        sessionId: "session-B",
        toolCall: { toolCallId: "shared-1", kind: "execute" },
        options: [
          { optionId: "accept", kind: "allow_once", name: "Yes, proceed" },
          { optionId: "decline", kind: "reject_once", name: "No" },
        ],
      },
    });

    expect(choices.length).toBe(1);
    expect(sent.some((m) => m.id === 700)).toBe(false);
    await manager.shutdown();
  });
});
