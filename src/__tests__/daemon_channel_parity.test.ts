import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { mcp } from "../server.js";
import { getHitlToolDefinitions, registerHitlTools } from "../mcp_tools.js";
import {
  DAEMON_INSTRUCTIONS,
  MCP_INSTRUCTIONS,
  STANDING_ORDERS,
} from "../mcp_instructions.js";

const snapshotPath = join(
  import.meta.dir,
  "fixtures",
  "channel_mode_snapshot.json",
);
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  instructions: string;
  standingOrders: string;
};

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

async function verifyChannelBoot(entryRelPath: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "hitl-parity-"));
  const port = await getFreePort();
  const identityFile = join(dir, "identity.json");
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.BUN_ENV;
  env.NODE_ENV = "production";
  env.HITL_CHANNEL_PORT = String(port);
  env.HITL_CHANNEL_IDENTITY_FILE = identityFile;

  const child = spawn(process.execPath, ["run", entryRelPath], {
    cwd: join(import.meta.dir, "..", ".."),
    env: env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    const deadline = Date.now() + 8000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.status === 200) {
          const json = (await res.json()) as { status?: string };
          if (json.status === "ok") {
            healthy = true;
            break;
          }
        }
      } catch {
        // waiting for bind
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(healthy).toBe(true);

    child.stdin.end();
    const exitCode = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(-1);
      }, 5000);
      child.once("exit", (code) => {
        clearTimeout(t);
        resolve(code);
      });
    });
    expect(exitCode).toBe(0);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("AV1 & AV7 — Channel mode snapshot parity and daemon tool/instruction contract", () => {
  it("AV1: channel mode tools/list output is byte-identical to pre-refactor snapshot", async () => {
    const handler = (mcp as any)._requestHandlers.get("tools/list");
    expect(handler).toBeDefined();
    const res = await handler({ method: "tools/list", params: {} });
    expect(JSON.stringify(res.tools)).toBe(JSON.stringify(snapshot.tools));
  });

  it("AV1: channel mode MCP_INSTRUCTIONS and STANDING_ORDERS are byte-identical to snapshot", () => {
    expect(MCP_INSTRUCTIONS).toBe(snapshot.instructions);
    expect(STANDING_ORDERS).toBe(snapshot.standingOrders);
  });

  it("AV7: daemon mode registers exact 7 tools with matching descriptions except reply_to_hitl daemon suffix", async () => {
    const daemonMcp = new Server(
      { name: "hitl-channel", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    registerHitlTools(daemonMcp, { mode: "daemon" });
    const handler = (daemonMcp as any)._requestHandlers.get("tools/list");
    const res = await handler({ method: "tools/list", params: {} });
    const daemonTools = res.tools as typeof snapshot.tools;

    expect(daemonTools.map((t) => t.name)).toEqual([
      "reply_to_hitl",
      "list_devices",
      "present_choices_to_hitl",
      "list_phone_tools",
      "call_phone_tool",
      "push_file",
      "present_questions_to_hitl",
    ]);
    expect(daemonTools.length).toBe(snapshot.tools.length);

    for (let i = 0; i < snapshot.tools.length; i++) {
      const ch = snapshot.tools[i]!;
      const dm = daemonTools[i]!;
      expect(dm.name).toBe(ch.name);
      expect(dm.inputSchema).toEqual(ch.inputSchema);
      if (dm.name === "reply_to_hitl") {
        expect(dm.description.startsWith(ch.description)).toBe(true);
        expect(dm.description).not.toBe(ch.description);
        expect(dm.description).toContain("message_id is ignored");
      } else {
        expect(dm.description).toBe(ch.description);
      }
    }

    expect(getHitlToolDefinitions("channel") as unknown[]).toEqual(snapshot.tools);
  });

  it("AV7: DAEMON_INSTRUCTIONS omits inbound message_id reply instruction and Claude Code version requirement", () => {
    expect(DAEMON_INSTRUCTIONS).not.toContain("with the inbound `message_id`");
    expect(DAEMON_INSTRUCTIONS).not.toContain("Claude Code");
    expect(DAEMON_INSTRUCTIONS).not.toContain("v2.1.80");
    expect(DAEMON_INSTRUCTIONS).not.toContain("--dangerously-load-development-channels");
    expect(DAEMON_INSTRUCTIONS).toContain("call_phone_tool");
    expect(DAEMON_INSTRUCTIONS).toContain("automatically");
    expect(DAEMON_INSTRUCTIONS).toContain("<workflow_delegation");
  });

  it("AV1: bun src/server.ts and cli.ts with no subcommand both start channel mode", async () => {
    await verifyChannelBoot("src/server.ts");
    await verifyChannelBoot("src/cli.ts");
  });
});
