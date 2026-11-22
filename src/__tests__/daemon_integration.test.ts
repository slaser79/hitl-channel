import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { hostname as osHostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAcpTransport } from "../acp_client.js";
import { getAuditDir, sha256Hex, type AuditEvent } from "../audit.js";
import { parseDaemonArgs, startDaemon, type DaemonHandle } from "../daemon.js";
import { broadcastReply, replyBuffer, startHttpBridge } from "../http_bridge.js";
import { loadIdentity } from "../identity.js";
import { removeFromAllowlist } from "../allowlist.js";

const FAKE_AGENT_PATH = join(
  import.meta.dir,
  "fixtures",
  "fake_acp_agent.ts",
);

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timed out waiting for predicate");
}

function readFakeAgentLog(logFile: string): Array<Record<string, unknown>> {
  try {
    const text = readFileSync(logFile, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("Daemon Mode Integration (AV2, AV3, AV5, AV6, AV7, AV9, AV10, AV11, AV12)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  function setupIsolatedEnv() {
    const dir = mkdtempSync(join(process.env.HOME!, "hitl-daemon-int-"));
    const prevEnv = {
      HITL_CHANNEL_IDENTITY_FILE: process.env.HITL_CHANNEL_IDENTITY_FILE,
      HITL_CHANNEL_NAME: process.env.HITL_CHANNEL_NAME,
      HITL_INSTANCE_ID: process.env.HITL_INSTANCE_ID,
      HITL_CHANNEL_API_KEY: process.env.HITL_CHANNEL_API_KEY,
    };
    delete process.env.HITL_CHANNEL_IDENTITY_FILE;
    delete process.env.HITL_CHANNEL_NAME;
    delete process.env.HITL_INSTANCE_ID;

    cleanups.push(() => {
      if (prevEnv.HITL_CHANNEL_IDENTITY_FILE !== undefined) {
        process.env.HITL_CHANNEL_IDENTITY_FILE = prevEnv.HITL_CHANNEL_IDENTITY_FILE;
      } else {
        delete process.env.HITL_CHANNEL_IDENTITY_FILE;
      }
      if (prevEnv.HITL_CHANNEL_NAME !== undefined) {
        process.env.HITL_CHANNEL_NAME = prevEnv.HITL_CHANNEL_NAME;
      } else {
        delete process.env.HITL_CHANNEL_NAME;
      }
      if (prevEnv.HITL_INSTANCE_ID !== undefined) {
        process.env.HITL_INSTANCE_ID = prevEnv.HITL_INSTANCE_ID;
      } else {
        delete process.env.HITL_INSTANCE_ID;
      }
      if (prevEnv.HITL_CHANNEL_API_KEY !== undefined) {
        process.env.HITL_CHANNEL_API_KEY = prevEnv.HITL_CHANNEL_API_KEY;
      } else {
        delete process.env.HITL_CHANNEL_API_KEY;
      }
      replyBuffer.drain();
      rmSync(dir, { recursive: true, force: true });
    });

    return dir;
  }

  it("honors a custom identity file and rejects an override outside the test directory", async () => {
    const dir = setupIsolatedEnv();
    const path = join(dir, "custom-identity.json");
    process.env.HITL_CHANNEL_IDENTITY_FILE = path;
    const identity = await loadIdentity();
    expect(await Bun.file(path).json()).toEqual(identity);
    expect(await loadIdentity()).toEqual(identity);

    const outside = mkdtempSync(join(tmpdir(), "hitl-outside-identity-"));
    try {
      process.env.HITL_CHANNEL_IDENTITY_FILE = join(outside, "identity.json");
      await expect(loadIdentity()).rejects.toThrow("outside the temporary test directory");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("AV2: parseDaemonArgs defaults port 8790, identity-daemon-agy.json differs from identity.json, displayName uses os.hostname(), pairing yields token with 0 ACP RPCs", async () => {
    const dir = setupIsolatedEnv();
    const origPortEnv = process.env.HITL_CHANNEL_PORT;
    delete process.env.HITL_CHANNEL_PORT;
    try {
      expect(parseDaemonArgs(["--harness", "agy"]).port).toBe(8790);
    } finally {
      if (origPortEnv !== undefined) process.env.HITL_CHANNEL_PORT = origPortEnv;
    }

    const channelIdentity = await loadIdentity();
    const logFile = join(dir, "fake_acp.log");
    const pairingCodes: string[] = [];
    const daemon = await startDaemon({
      harness: "agy",
      port: 0,
      cwd: dir,
      enableMdns: false,
      enableDesktopNotifications: false,
      transportFactory: (_cmd, _args, opts) =>
        spawnAcpTransport(process.execPath, ["run", FAKE_AGENT_PATH], {
          cwd: opts?.cwd,
          env: { FAKE_ACP_LOG_FILE: logFile },
        }),
      onPairingCode: (code) => {
        pairingCodes.push(code);
      },
    });
    cleanups.push(() => daemon.shutdown());

    const daemonIdFile = join(process.env.HITL_CHANNEL_HOME!, "identity-daemon-agy.json");
    const persisted = JSON.parse(readFileSync(daemonIdFile, "utf8")) as {
      instanceId: string;
      displayName: string;
    };
    expect(persisted.instanceId).toBe(daemon.instanceId);
    expect(persisted.instanceId).not.toBe(channelIdentity.instanceId);
    expect(persisted.displayName).toBe(`agy@${osHostname()}`);
    expect(persisted.displayName).not.toBe("agy@unknown");

    // GET /instance matches
    const instRes = await fetch(`http://127.0.0.1:${daemon.port}/instance`);
    expect(instRes.status).toBe(200);
    const instJson = (await instRes.json()) as {
      instanceId: string;
      displayName: string;
    };
    expect(instJson.instanceId).toBe(daemon.instanceId);
    expect(instJson.displayName).toBe(`agy@${osHostname()}`);

    // POST /pair/request causes 0 ACP RPCs and prints 6-digit code to stdout
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const pairReq = await fetch(`http://127.0.0.1:${daemon.port}/pair/request`, {
        method: "POST",
      });
      expect(pairReq.status).toBe(202);
      expect(pairingCodes.length).toBe(1);
      expect(pairingCodes[0]).toMatch(/^\d{6}$/);
      const printedToStdout = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(printedToStdout).toContain(pairingCodes[0]!);
      expect(readFakeAgentLog(logFile).length).toBe(0);
    } finally {
      stdoutSpy.mockRestore();
    }

    // POST /pair/validate returns device_token valid for POST / and /ws
    const valRes = await fetch(`http://127.0.0.1:${daemon.port}/pair/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairingCodes[0] }),
    });
    expect(valRes.status).toBe(200);
    const valJson = (await valRes.json()) as { device_token: string };
    expect(valJson.device_token).toBeTruthy();
    cleanups.push(() => removeFromAllowlist(valJson.device_token));

    // Verify WS + POST / both work with paired token
    const ws = new WebSocket(
      `ws://127.0.0.1:${daemon.port}/ws?token=${valJson.device_token}`,
    );
    cleanups.push(() => ws.close());
    const wsReplies: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      ws.onmessage = (ev) => {
        const parsed = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (parsed.type === "reply") {
          ws.send(JSON.stringify({ type: "ack", id: parsed.id }));
        }
        wsReplies.push(parsed);
      };
    });

    const postRes = await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${valJson.device_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "hello via paired token" }),
    });
    expect(postRes.status).toBe(200);
    await waitFor(() =>
      wsReplies.some((r) => r.text === "echo:hello via paired token"),
    );

    // AV11: Fake child received HITL_DAEMON_SESSION=1
    const startupEvt = readFakeAgentLog(logFile).find(
      (e) => e.event === "startup",
    );
    expect(startupEvt?.hitl_daemon_session).toBe("1");
  });

  it("AV3, AV5, AV6, AV7, AV9, AV12: full HTTP/WS round-trips, 2 sequential MCP sessions, audit attribution, loopback auth & no relay", async () => {
    const dir = setupIsolatedEnv();
    const apiKey = "int-test-key";
    process.env.HITL_CHANNEL_API_KEY = apiKey;
    const logFile = join(dir, "fake_acp.log");

    const daemon: DaemonHandle = await startDaemon({
      harness: "agy",
      port: 0,
      cwd: dir,
      enableMdns: false,
      enableDesktopNotifications: false,
      transportFactory: (_cmd, _args, opts) =>
        spawnAcpTransport(process.execPath, ["run", FAKE_AGENT_PATH], {
          cwd: opts?.cwd,
          env: { FAKE_ACP_LOG_FILE: logFile },
        }),
    });
    cleanups.push(() => daemon.shutdown());

    // AV12: loopback MCP binds 127.0.0.1, rejects missing bearer with 401, /.well-known returns 404 without auth
    expect(daemon.mcpUrl.startsWith("http://127.0.0.1:")).toBe(true);
    const wellKnownRes = await fetch(
      `${new URL(daemon.mcpUrl).origin}/.well-known/oauth-protected-resource`,
    );
    expect(wellKnownRes.status).toBe(404);
    const unauthMcpRes = await fetch(daemon.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(unauthMcpRes.status).toBe(401);

    // AV12 static check: no hitlrelay.app in src/ (excluding __tests__)
    const srcFiles = readdirSync(join(import.meta.dir, "..")).filter((f) =>
      f.endsWith(".ts"),
    );
    for (const file of srcFiles) {
      const content = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect(content).not.toContain("hitlrelay.app");
    }

    // AV3: POST / and WS chat frame both deliver identical questions_batch_response prompt text
    const ws = new WebSocket(
      `ws://127.0.0.1:${daemon.port}/ws?api_key=${apiKey}`,
    );
    const receivedFrames: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      ws.onmessage = (ev) => {
        const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
        receivedFrames.push(frame);
        if (frame.type === "reply" && frame.id) {
          ws.send(JSON.stringify({ type: "ack", id: frame.id }));
        } else if (frame.type === "tool_call_request") {
          ws.send(
            JSON.stringify({
              type: "tool_call_result",
              request_id: frame.request_id,
              success: true,
              approval: "auto",
              output: `phone_ok:${String((frame.arguments as Record<string, unknown>)?.from ?? "")}`,
            }),
          );
        }
      };
    });

    const flatBatchPayload = {
      type: "questions_batch_response",
      content: "Submitted 1 answer",
      batch_id: "qb-1",
      batch_answer: {
        answers: [{ header: "Env", selected: ["Prod"] }],
        cancelled: false,
      },
    };
    await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(flatBatchPayload),
    });
    await waitFor(() =>
      receivedFrames.some(
        (f) => f.text === "echo:Submitted 1 answer — Env: [Prod]",
      ),
    );

    receivedFrames.length = 0;
    ws.send(JSON.stringify(flatBatchPayload));
    await waitFor(() =>
      receivedFrames.some(
        (f) => f.text === "echo:Submitted 1 answer — Env: [Prod]",
      ),
    );

    // AV6: Two sequential sessions calling loopback MCP (server/discover + initialize + call_phone_tool)
    await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "/new" }),
    });
    await waitFor(() => receivedFrames.some((f) => String(f.text ?? "").includes("fake-sess-2")));

    await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "__MCP_CALL__:ping_tool_1" }),
    });
    await waitFor(() =>
      receivedFrames.some((f) => String(f.text ?? "").includes("phone_ok:fake-sess-2")),
    );

    // Session 3 (second sequential MCP session)
    await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "/new" }),
    });
    await waitFor(() => receivedFrames.some((f) => String(f.text ?? "").includes("fake-sess-3")));

    await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "__MCP_CALL__:ping_tool_2" }),
    });
    await waitFor(() =>
      receivedFrames.some((f) => String(f.text ?? "").includes("phone_ok:fake-sess-3")),
    );

    // Check pre-initialize server/discover received JSON-RPC -32601 (not HTTP 4xx)
    const discoverLogs = readFakeAgentLog(logFile).filter(
      (e) => e.event === "mcp_discover",
    );
    expect(discoverLogs.length).toBe(2);
    for (const d of discoverLogs) {
      const resp = d.discoverResp as { status: number; json: { error?: { code?: number } } };
      expect(resp.status).toBe(200);
      expect(resp.json.error?.code).toBe(-32601);
    }

    // AV7 & AV9: daemon reply_to_hitl strips message_id and preserves attachments; delegation sends 1 frame with message_id
    receivedFrames.length = 0;
    await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "__REPLY_IMAGE__:SHOULD_BE_STRIPPED" }),
    });
    await waitFor(() =>
      receivedFrames.some((f) => f.type === "reply" && Array.isArray(f.attachments)),
    );
    const imgFrame = receivedFrames.find(
      (f) => f.type === "reply" && Array.isArray(f.attachments),
    )!;
    expect(imgFrame.text).toBe("interim image");
    expect(imgFrame.message_id).toBeUndefined();

    receivedFrames.length = 0;
    await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: '<workflow_delegation message_id="X-DEL">__CALL_REPLY_FIRST__</workflow_delegation>',
      }),
    });
    await waitFor(() =>
      receivedFrames.some((f) => f.text === "FINAL_DELEGATION_ANSWER"),
    );
    const withMsgId = receivedFrames.filter((f) => f.message_id === "X-DEL");
    expect(withMsgId.length).toBe(1);
    expect(withMsgId[0]!.text).toBe("FINAL_DELEGATION_ANSWER");

    // AV5: ReplyBuffer reconnect-drain replay when WS disconnected
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "while_offline" }),
    });
    await waitFor(() => replyBuffer.size() > 0);

    const reconnectedReplies: Array<Record<string, unknown>> = [];
    const ws2 = new WebSocket(
      `ws://127.0.0.1:${daemon.port}/ws?api_key=${apiKey}`,
    );
    cleanups.push(() => ws2.close());
    await new Promise<void>((resolve, reject) => {
      ws2.onopen = () => resolve();
      ws2.onerror = (e) => reject(e);
      ws2.onmessage = (ev) => {
        const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (frame.type === "reply") {
          reconnectedReplies.push(frame);
          ws2.send(JSON.stringify({ type: "ack", id: frame.id }));
        }
      };
    });
    await waitFor(() =>
      reconnectedReplies.some((r) => r.text === "echo:while_offline"),
    );

    // AV6 Audit check: acp_session_id populated from _meta["antigravity.google/conversation_id"]
    const todayAuditFile = join(
      getAuditDir(),
      `${new Date().toISOString().slice(0, 10)}.jsonl`,
    );
    await waitFor(() => {
      try {
        const rows = readFileSync(todayAuditFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as AuditEvent)
          .filter((r) => r.instance_id === daemon.instanceId);
        return (
          rows.some((r) => r.kind === "tool_call" && r.tool_name === "ping_tool_1") &&
          rows.some((r) => r.kind === "tool_call" && r.tool_name === "ping_tool_2") &&
          rows.some(
            (r) =>
              r.direction === "phone_to_cc" &&
              r.kind === "message" &&
              r.prompt_hash === sha256Hex("while_offline"),
          )
        );
      } catch {
        return false;
      }
    });
    const auditRows = readFileSync(todayAuditFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEvent)
      .filter((r) => r.instance_id === daemon.instanceId);
    const toolAudit = auditRows.find(
      (r) => r.kind === "tool_call" && r.tool_name === "ping_tool_1",
    );
    expect(toolAudit?.acp_session_id).toBe("fake-sess-2");
    const toolAudit2 = auditRows.find(
      (r) => r.kind === "tool_call" && r.tool_name === "ping_tool_2",
    );
    expect(toolAudit2?.acp_session_id).toBe("fake-sess-3");
    const inboundPromptAudit = auditRows.find(
      (r) =>
        r.direction === "phone_to_cc" &&
        r.kind === "message" &&
        r.prompt_hash === sha256Hex("while_offline"),
    );
    expect(inboundPromptAudit?.acp_session_id).toBe("fake-sess-3");
  });

  it("AV10: SIGTERM terminates daemon and entire child process group within 5s", async () => {
    const dir = setupIsolatedEnv();
    const logFile = join(dir, "pgid_acp.log");
    const port = await getFreePort();
    const childIdentity = join(dir, "identity-pgid.json");

    // Spawn a real daemon CLI subprocess that starts fake_acp_agent with a grandchild sleep process
    const runnerScript = join(dir, "run_daemon.ts");
    await Bun.write(
      runnerScript,
      `
import { startDaemon, type DaemonHandle } from "${join(import.meta.dir, "..", "daemon.js")}";
import { spawnAcpTransport } from "${join(import.meta.dir, "..", "acp_client.js")}";
let d: DaemonHandle | undefined;
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  if (d) void d.shutdown().finally(() => process.exit(0));
});
d = await startDaemon({
  harness: "agy",
  port: ${port},
  cwd: ${JSON.stringify(dir)},
  identityFile: ${JSON.stringify(childIdentity)},
  enableMdns: false,
  enableDesktopNotifications: false,
  startHarnessImmediately: true,
  transportFactory: (_c, _a, opts) =>
    spawnAcpTransport(${JSON.stringify(process.execPath)}, ["run", ${JSON.stringify(FAKE_AGENT_PATH)}], {
      cwd: opts?.cwd,
      env: { FAKE_ACP_LOG_FILE: ${JSON.stringify(logFile)}, FAKE_ACP_SPAWN_GRANDCHILD: "1" },
    }),
});
if (stopping) {
  await d.shutdown();
  process.exit(0);
}
process.stdout.write("READY\\n");
`,
    );

    const daemonProc = spawn(process.execPath, ["run", runnerScript], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push(() => {
      try {
        daemonProc.kill("SIGKILL");
      } catch {
        // ignore
      }
    });

    await waitFor(async () => {
      if (!readFakeAgentLog(logFile).some((e) => e.event === "startup")) return false;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        return res.status === 200;
      } catch {
        return false;
      }
    });
    const startup = readFakeAgentLog(logFile).find(
      (e) => e.event === "startup",
    )!;
    const childPid = Number(startup.pid);
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);

    const t0 = Date.now();
    daemonProc.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => resolve(-1), 5000);
      daemonProc.once("exit", (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    expect(exitCode).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);

    // Verify child process group is gone (ESRCH)
    let alive = true;
    try {
      process.kill(-childPid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("startHttpBridge drains stale replyBuffer entries on startup", async () => {
    setupIsolatedEnv();
    const apiKey = process.env.HITL_CHANNEL_API_KEY = "test-bridge-reset-key";
    broadcastReply("stale leak from earlier bridge or test");
    expect(replyBuffer.size()).toBeGreaterThan(0);

    const bridge = startHttpBridge(
      {
        async onInbound() {},
        async onPairingCode() {},
      },
      { port: 0 },
    );
    cleanups.push(() => bridge.stop(true));
    expect(replyBuffer.size()).toBe(0);

    const received: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws?api_key=${apiKey}`);
    cleanups.push(() => ws.close());
    ws.onmessage = (ev) => {
      received.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
    broadcastReply("fresh reply");
    await waitFor(() => received.some((r) => r.text === "fresh reply"));
    expect(received.some((r) => r.text === "stale leak from earlier bridge or test")).toBe(false);
  });
});
