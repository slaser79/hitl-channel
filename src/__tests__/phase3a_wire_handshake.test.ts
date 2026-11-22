import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Bonjour } from "bonjour-service";
import { spawnAcpTransport } from "../acp_client.js";
import { startDaemon } from "../daemon.js";
import {
  broadcastToCapable,
  clients,
  replyBuffer,
  sendControlToClient,
  startHttpBridge,
} from "../http_bridge.js";
import { startMDNS, stopMDNS } from "../mdns.js";
import type { HitlWebSocket } from "../types.js";

const FAKE_AGENT_PATH = join(import.meta.dir, "fixtures", "fake_acp_agent.ts");

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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("Timed out waiting for predicate");
}

describe("SPEC-HITL-APP-10827 Milestone 3a AV1: /instance, mDNS, client_hello feature isolation", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
    clients.clear();
    replyBuffer.drain();
  });

  function setupIsolatedEnv() {
    const dir = mkdtempSync(
      join(process.env.HITL_CHANNEL_TEST_ROOT || tmpdir(), "hitl-p3a-wire-"),
    );
    const prev = {
      HOME: process.env.HOME,
      HITL_CHANNEL_IDENTITY_FILE: process.env.HITL_CHANNEL_IDENTITY_FILE,
      HITL_CHANNEL_NAME: process.env.HITL_CHANNEL_NAME,
      HITL_INSTANCE_ID: process.env.HITL_INSTANCE_ID,
      HITL_CHANNEL_API_KEY: process.env.HITL_CHANNEL_API_KEY,
    };
    process.env.HOME = dir;
    process.env.HITL_CHANNEL_API_KEY = "p3a-wire-key";
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
      rmSync(dir, { recursive: true, force: true });
    });

    return dir;
  }

  it("AV1: GET /instance emits mode, harness, capabilities without defaultCwd in channel and daemon modes", async () => {
    const dir = setupIsolatedEnv();

    // Channel mode via real server.ts subprocess
    const channelPort = await getFreePort();
    const channelIdentity = join(dir, "channel-identity.json");
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.BUN_ENV;
    env.NODE_ENV = "production";
    env.HITL_CHANNEL_PORT = String(channelPort);
    env.HITL_CHANNEL_IDENTITY_FILE = channelIdentity;
    const channelChild = spawn(process.execPath, ["run", "src/server.ts"], {
      cwd: join(import.meta.dir, "..", ".."),
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanups.push(async () => {
      try {
        channelChild.stdin.end();
        channelChild.kill("SIGTERM");
      } catch {
        // ignore
      }
    });

    let channelInst: Record<string, unknown> | null = null;
    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${channelPort}/instance`);
        if (res.status === 200) {
          channelInst = (await res.json()) as Record<string, unknown>;
          return true;
        }
        return false;
      } catch {
        return false;
      }
    });
    expect(channelInst).not.toBeNull();
    expect(channelInst!.mode).toBe("channel");
    expect(channelInst!.harness).toBe("claude-code");
    expect(channelInst!.capabilities).toEqual({
      sessions: false,
      streaming: false,
      choicesId: true,
    });
    expect("defaultCwd" in channelInst!).toBe(false);

    // Daemon mode (codex)
    const daemon = await startDaemon({
      harness: "codex",
      port: 0,
      cwd: dir,
      enableMdns: false,
      enableDesktopNotifications: false,
      transportFactory: (_c, _a, opts) =>
        spawnAcpTransport(process.execPath, ["run", FAKE_AGENT_PATH], {
          cwd: opts?.cwd,
        }),
    });
    cleanups.push(() => daemon.shutdown());

    const daemonRes = await fetch(`http://127.0.0.1:${daemon.port}/instance`);
    expect(daemonRes.status).toBe(200);
    const daemonInst = (await daemonRes.json()) as Record<string, unknown>;
    expect(daemonInst.instanceId).toBe(daemon.instanceId);
    expect(daemonInst.mode).toBe("daemon");
    expect(daemonInst.harness).toBe("codex");
    expect(daemonInst.capabilities).toEqual({
      sessions: true,
      streaming: true,
      choicesId: true,
    });
    expect("defaultCwd" in daemonInst).toBe(false);
    expect(JSON.stringify(daemonInst)).not.toContain(dir);

    // Direct startHttpBridge default channel behavior
    const bridge = startHttpBridge({ notification: async () => {} } as unknown as Server, {
      port: 0,
    });
    cleanups.push(() => bridge.stop(true));
    const bridgeRes = await fetch(`http://127.0.0.1:${bridge.port}/instance`);
    const bridgeInst = (await bridgeRes.json()) as Record<string, unknown>;
    expect(bridgeInst.mode).toBe("channel");
    expect(bridgeInst.harness).toBe("claude-code");
    expect(bridgeInst.capabilities).toEqual({
      sessions: false,
      streaming: false,
      choicesId: true,
    });
    expect("defaultCwd" in bridgeInst).toBe(false);
  });

  it("AV1: startMDNS includes mode and harness in TXT records and never leaks defaultCwd", () => {
    const published: Array<Record<string, unknown>> = [];
    const publishSpy = spyOn(Bonjour.prototype, "publish").mockImplementation(
      (opts: unknown) => {
        published.push(opts as Record<string, unknown>);
        return { stop: () => {} } as unknown as ReturnType<Bonjour["publish"]>;
      },
    );
    const destroySpy = spyOn(Bonjour.prototype, "destroy").mockImplementation(() => {});
    cleanups.push(() => {
      stopMDNS();
      publishSpy.mockRestore();
      destroySpy.mockRestore();
    });

    startMDNS(8791, "inst-codex-1234", "codex@Mac", {
      mode: "daemon",
      harness: "codex",
      defaultCwd: "/secret/user/path",
    } as { mode?: string; harness?: string });

    expect(published.length).toBe(1);
    const txt = published[0]!.txt as Record<string, string>;
    expect(txt.instanceId).toBe("inst-codex-1234");
    expect(txt.displayName).toBe("codex@Mac");
    expect(txt.mode).toBe("daemon");
    expect(txt.harness).toBe("codex");
    expect("defaultCwd" in txt).toBe(false);
    expect(JSON.stringify(txt)).not.toContain("/secret/user/path");
  });

  it("AV1: broadcastToCapable & sendControlToClient isolate Phase-3 frames from legacy sockets and never touch replyBuffer", () => {
    const legacySent: string[] = [];
    const choicesOnlySent: string[] = [];
    const sessionsSent: string[] = [];
    const closedCapableSent: string[] = [];

    const legacyWs: HitlWebSocket = {
      readyState: 1,
      data: { tokenHash: "legacy" },
      send: (d) => {
        legacySent.push(d);
        return 1;
      },
    };
    const choicesOnlyWs: HitlWebSocket = {
      readyState: 1,
      data: { tokenHash: "choices", proto: 3, features: new Set(["choices_settled"]) },
      send: (d) => {
        choicesOnlySent.push(d);
        return 1;
      },
    };
    const sessionsWs: HitlWebSocket = {
      readyState: 1,
      data: {
        tokenHash: "sessions",
        proto: 3,
        features: new Set(["sessions", "choices_settled"]),
      },
      send: (d) => {
        sessionsSent.push(d);
        return 1;
      },
    };
    const closedWs: HitlWebSocket = {
      readyState: 3,
      data: { tokenHash: "closed", proto: 3, features: new Set(["sessions"]) },
      send: (d) => {
        closedCapableSent.push(d);
        return 1;
      },
    };

    clients.add(legacyWs);
    clients.add(choicesOnlyWs);
    clients.add(sessionsWs);
    clients.add(closedWs);

    const count = broadcastToCapable("sessions", { type: "session_list", sessions: [] });
    expect(count).toBe(1);
    expect(legacySent.length).toBe(0);
    expect(choicesOnlySent.length).toBe(0);
    expect(sessionsSent.length).toBe(1);
    expect(closedCapableSent.length).toBe(0);
    expect(replyBuffer.size()).toBe(0);

    // sendControlToClient rejects sockets without client_hello or closed sockets
    expect(sendControlToClient(legacyWs, { type: "session_list" })).toBe(false);
    expect(sendControlToClient(closedWs, { type: "session_list" })).toBe(false);
    expect(sendControlToClient(choicesOnlyWs, { type: "session_list" }, "sessions")).toBe(
      false,
    );
    expect(sendControlToClient(sessionsWs, { type: "session_list" }, "sessions")).toBe(
      true,
    );
    expect(sessionsSent.length).toBe(2);
    expect(replyBuffer.size()).toBe(0);
  });

  it("AV1: live WS client_hello unicasts initial session_list, never queues prompt, and isolates legacy WS from all Phase-3 frames", async () => {
    const dir = setupIsolatedEnv();
    const logFile = join(dir, "fake_acp.log");
    const daemon = await startDaemon({
      harness: "agy",
      port: 0,
      cwd: dir,
      enableMdns: false,
      enableDesktopNotifications: false,
      transportFactory: (_c, _a, opts) =>
        spawnAcpTransport(process.execPath, ["run", FAKE_AGENT_PATH], {
          cwd: opts?.cwd,
          env: { FAKE_ACP_LOG_FILE: logFile },
        }),
    });
    cleanups.push(() => daemon.shutdown());

    const legacyFrames: Array<Record<string, unknown>> = [];
    const choicesOnlyFrames: Array<Record<string, unknown>> = [];
    const upgradedFrames: Array<Record<string, unknown>> = [];

    const openWs = async (sink: Array<Record<string, unknown>>) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${daemon.port}/ws?api_key=p3a-wire-key`,
      );
      cleanups.push(() => ws.close());
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = (e) => reject(e);
      });
      ws.onmessage = (ev) => {
        const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
        sink.push(frame);
        if (frame.type === "reply" && frame.id) {
          ws.send(JSON.stringify({ type: "ack", id: frame.id }));
        }
      };
      return ws;
    };

    await openWs(legacyFrames);
    const wsChoices = await openWs(choicesOnlyFrames);
    const wsUpgraded = await openWs(upgradedFrames);

    wsChoices.send(
      JSON.stringify({
        type: "client_hello",
        proto: 3,
        features: ["choices_settled"],
      }),
    );
    wsUpgraded.send(
      JSON.stringify({
        type: "client_hello",
        proto: 3,
        features: ["sessions", "choices_settled"],
      }),
    );

    await waitFor(() => upgradedFrames.some((f) => f.type === "session_list"));
    const initList = upgradedFrames.find((f) => f.type === "session_list")!;
    expect(initList.defaultCwd).toBe(dir);
    expect(initList.recentCwds).toEqual([dir]);
    expect(initList.activeSessionId).toBeNull();
    expect(initList.sessions).toEqual([]);
    expect(replyBuffer.size()).toBe(0);

    // client_hello must NOT trigger ACP spawn or session/prompt
    await new Promise((r) => setTimeout(r, 40));
    expect(legacyFrames.length).toBe(0);
    expect(choicesOnlyFrames.length).toBe(0);

    // Trigger session_new via upgraded WS -> only wsUpgraded gets session_switched + session_list
    wsUpgraded.send(JSON.stringify({ type: "session_new", requestId: "req-n1" }));
    await waitFor(() => upgradedFrames.some((f) => f.type === "session_switched"));
    await new Promise((r) => setTimeout(r, 40));

    expect(legacyFrames.length).toBe(0);
    expect(choicesOnlyFrames.length).toBe(0);

    // Trigger permission + /cancel -> upgraded + choicesOnly receive choices_settled, legacy does NOT
    await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: {
        authorization: "Bearer p3a-wire-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "__PERM_TEST__" }),
    });
    await waitFor(
      () =>
        legacyFrames.some((f) => f.type === "choices") ||
        choicesOnlyFrames.some((f) => f.type === "choices") ||
        upgradedFrames.some((f) => f.type === "choices"),
    );

    await fetch(`http://127.0.0.1:${daemon.port}/`, {
      method: "POST",
      headers: {
        authorization: "Bearer p3a-wire-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "/cancel" }),
    });

    await waitFor(
      () =>
        upgradedFrames.some((f) => f.type === "choices_settled") &&
        choicesOnlyFrames.some((f) => f.type === "choices_settled"),
    );
    await waitFor(() =>
      legacyFrames.some((f) => f.type === "reply" && f.text === "⏹ cancelled"),
    );

    // Legacy socket received ZERO Phase-3 frames
    const phase3Types = new Set([
      "session_list",
      "session_switched",
      "session_error",
      "choices_settled",
    ]);
    expect(legacyFrames.some((f) => phase3Types.has(String(f.type)))).toBe(false);
    expect(choicesOnlyFrames.some((f) => String(f.type).startsWith("session_"))).toBe(
      false,
    );
  });
});
