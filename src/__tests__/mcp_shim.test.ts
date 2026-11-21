import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startLoopbackMcpServer } from "../daemon.js";
import {
  assertLoopbackHttpUrl,
  createMcpShimProcessor,
  parseMcpShimArgs,
  parseSsePayloads,
} from "../mcp_shim.js";

const CLI_PATH = fileURLToPath(new URL("../cli.ts", import.meta.url));

describe("mcp-shim CLI & URL validation", () => {
  it("accepts loopback HTTP URLs (127.0.0.1, localhost, [::1]) and rejects non-loopback or HTTPS", () => {
    expect(assertLoopbackHttpUrl("http://127.0.0.1:8080/mcp")).toBe(
      "http://127.0.0.1:8080/mcp",
    );
    expect(assertLoopbackHttpUrl("http://localhost:8080/mcp")).toBe(
      "http://localhost:8080/mcp",
    );
    expect(assertLoopbackHttpUrl("http://[::1]:8080/mcp")).toBe(
      "http://[::1]:8080/mcp",
    );
    expect(() => assertLoopbackHttpUrl("https://127.0.0.1:8080/mcp")).toThrow(
      /http:\/\//i,
    );
    expect(() => assertLoopbackHttpUrl("http://10.0.0.5:8080/mcp")).toThrow(
      /non-loopback/i,
    );
    expect(() => assertLoopbackHttpUrl("http://hitlrelay.app/mcp")).toThrow(
      /non-loopback/i,
    );
  });

  it("parses flags and HITL_MCP_SHIM_TOKEN / HITL_MCP_SHIM_SESSION_ID env vars", () => {
    const parsed = parseMcpShimArgs(
      ["--url", "http://127.0.0.1:12345/mcp"],
      {
        HITL_MCP_SHIM_TOKEN: "secret-tok",
        HITL_MCP_SHIM_SESSION_ID: "sess-99",
      },
    );
    expect(parsed.url).toBe("http://127.0.0.1:12345/mcp");
    expect(parsed.token).toBe("secret-tok");
    expect(parsed.acpSessionId).toBe("sess-99");
    expect(parsed.help).toBe(false);

    const flagOverride = parseMcpShimArgs(
      [
        "--url=http://localhost:5555/mcp",
        "--token=tok2",
        "--acp-session-id=sess-2",
      ],
      {},
    );
    expect(flagOverride.token).toBe("tok2");
    expect(flagOverride.acpSessionId).toBe("sess-2");

    expect(() => parseMcpShimArgs([], {})).toThrow(/--url/);
    expect(() =>
      parseMcpShimArgs(["--url", "http://127.0.0.1:5555/mcp"], {}),
    ).toThrow(/--token/);
  });

  it("parses multi-line SSE payloads and ignores [DONE] and empty events", () => {
    const payloads = parseSsePayloads(
      [
        "event: message",
        "data: {\"jsonrpc\":\"2.0\",",
        "data: \"id\":1,\"result\":{\"ok\":true}}",
        "",
        "data: [DONE]",
        "",
        "data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}",
        "",
      ].join("\n"),
    );
    expect(payloads).toEqual([
      '{"jsonrpc":"2.0",\n"id":1,"result":{"ok":true}}',
      '{"jsonrpc":"2.0","id":2,"result":{}}',
    ]);
  });
});

describe("createMcpShimProcessor", () => {
  it("handles 202 notifications silently, SSE frames, HTTP errors, and network failures", async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    let reqCount = 0;

    const proc = createMcpShimProcessor({
      url: "http://127.0.0.1:9999/mcp",
      token: "tok",
      acpSessionId: "sess-a",
      writeLine: (l) => lines.push(l),
      writeError: (e) => errors.push(e),
      fetchImpl: (async (_url, init) => {
        reqCount++;
        const hdrs = init?.headers as Record<string, string>;
        expect(hdrs.authorization).toBe("Bearer tok");
        expect(hdrs["x-hitl-acp-session-id"]).toBe("sess-a");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (body.id === 10) {
          return new Response(
            'event: message\ndata: {"jsonrpc":"2.0","id":10,"result":{"sse":true}}\n\n',
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        if (body.id === 11) {
          return new Response("unauthorized", { status: 401 });
        }
        throw new Error("connection refused");
      }) as typeof fetch,
    });

    await proc("not-valid-json");
    expect(lines.length).toBe(0);
    expect(errors.length).toBe(1);

    await proc(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(reqCount).toBe(1);
    expect(lines.length).toBe(0);

    await proc(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list" }));
    expect(JSON.parse(lines.at(-1)!)).toEqual({
      jsonrpc: "2.0",
      id: 10,
      result: { sse: true },
    });

    await proc(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list" }));
    const err11 = JSON.parse(lines.at(-1)!);
    expect(err11.id).toBe(11);
    expect(err11.error.code).toBe(-32000);
    expect(err11.error.message).toContain("HTTP 401");

    await proc(JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/list" }));
    const err12 = JSON.parse(lines.at(-1)!);
    expect(err12.id).toBe(12);
    expect(err12.error.code).toBe(-32000);
    expect(err12.error.message).toContain("connection refused");
  });

  it("bridges real stdio subprocess (`cli.ts mcp-shim`) to startLoopbackMcpServer with session attribution", async () => {
    const replySessions: Array<string | null | undefined> = [];
    const srv = startLoopbackMcpServer({
      onReplySent: (sid) => replySessions.push(sid),
    });

    const child = spawn(
      process.execPath,
      ["run", CLI_PATH, "mcp-shim", "--url", srv.url],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          HITL_MCP_SHIM_TOKEN: srv.token,
          HITL_MCP_SHIM_SESSION_ID: "shim-sess-77",
        },
      },
    );

    const outLines: Record<string, unknown>[] = [];
    let buf = "";
    const resolvers: Array<() => void> = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          outLines.push(JSON.parse(line) as Record<string, unknown>);
          resolvers.forEach((fn) => fn());
        }
        nl = buf.indexOf("\n");
      }
    });

    const waitForId = (id: number) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const found = outLines.find((m) => m.id === id);
        if (found) return resolve(found);
        const check = () => {
          const match = outLines.find((m) => m.id === id);
          if (match) resolve(match);
        };
        resolvers.push(check);
      });

    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test-shim-client", version: "0.1.0" },
          },
        }) + "\n",
      );
      const initRes = await waitForId(1);
      expect((initRes.result as Record<string, unknown>).serverInfo).toBeTruthy();

      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
      );

      // Fire concurrent tools/list and reply_to_hitl calls over stdio
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) +
          "\n" +
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "reply_to_hitl", arguments: { text: "hello via shim" } },
          }) +
          "\n",
      );

      const [toolsRes, replyRes] = await Promise.all([waitForId(2), waitForId(3)]);
      const toolNames = (
        ((toolsRes.result as Record<string, unknown>).tools as Array<{ name: string }>) ?? []
      ).map((t) => t.name);
      expect(toolNames).toContain("call_phone_tool");
      expect(toolNames).toContain("reply_to_hitl");
      expect(replyRes.error).toBeUndefined();
      expect(replySessions).toEqual(["shim-sess-77"]);

      // Close stdin cleanly and verify shim exits 0
      child.stdin.end();
      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
      });
      expect(exitCode).toBe(0);
    } finally {
      child.kill("SIGTERM");
      srv.stop();
    }
  });
});
