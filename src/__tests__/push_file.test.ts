import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mcp } from "../server.js";
import { clients, correlator } from "../http_bridge.js";
import { writeFileSync, unlinkSync, mkdirSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

describe("push_file MCP Tool", () => {
  const originalEnv = process.env.HITL_CHANNEL_ATTACHMENT_ROOTS;

  beforeAll(() => {
    // Set a custom attachment roots for testing
    process.env.HITL_CHANNEL_ATTACHMENT_ROOTS = "/tmp";
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.HITL_CHANNEL_ATTACHMENT_ROOTS = originalEnv;
    } else {
      delete process.env.HITL_CHANNEL_ATTACHMENT_ROOTS;
    }
  });

  it("should be registered on the hitl-channel MCP server", async () => {
    const listHandler = (mcp as any)._requestHandlers.get("tools/list");
    expect(listHandler).toBeDefined();
    const result = await listHandler({ method: "tools/list" });
    const pushFileTool = result.tools.find((t: any) => t.name === "push_file");
    expect(pushFileTool).toBeDefined();
    expect(pushFileTool.description).toContain("Push a text file");
    expect(pushFileTool.inputSchema.properties.local_path).toBeDefined();
    expect(pushFileTool.inputSchema.properties.dest).toBeDefined();
  });

  it("should be absent from the phone tool catalog returned by list_phone_tools", async () => {
    const callHandler = (mcp as any)._requestHandlers.get("tools/call");
    expect(callHandler).toBeDefined();

    // Mock a WS client to satisfy clients.size === 0 guard
    const mockWs = {
      readyState: 1,
      send: () => true,
    } as any;
    clients.add(mockWs);

    try {
      const requestId = "req-list-tools";
      // We expect list_phone_tools to send a request and wait for reply
      const listToolsPromise = callHandler({
        method: "tools/call",
        params: {
          name: "list_phone_tools",
        },
      });

      // Resolve the waiter via correlator
      // First, let's wait a tiny bit for the request to register in correlator
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Get the request ID from the correlator
      const activeReqIds = Array.from((correlator as any).pending.keys());
      expect(activeReqIds.length).toBe(1);
      const activeId = activeReqIds[0] as string;

      correlator.resolve(activeId, {
        type: "list_tools_result",
        request_id: activeId,
        tools: [
          {
            name: "write_file",
            description: "writes a file",
          },
        ],
      });

      const result = await listToolsPromise;
      const toolsObj = JSON.parse(result.content[0].text);
      const hasPushFile = toolsObj.tools.some((t: any) => t.name === "push_file");
      expect(hasPushFile).toBe(false);
    } finally {
      clients.delete(mockWs);
    }
  });

  it("should reject local_path outside allowlisted roots", async () => {
    const callHandler = (mcp as any)._requestHandlers.get("tools/call");

    const outsideFile = "/home/slaser79/outside.txt";
    const result = await callHandler({
      method: "tools/call",
      params: {
        name: "push_file",
        arguments: {
          local_path: outsideFile,
          dest: "documents/test.txt",
        },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("path outside allowlist");
  });

  it("should reject symlink-escaping paths", async () => {
    const callHandler = (mcp as any)._requestHandlers.get("tools/call");

    // Create a symlink to escape the roots
    const symlinkPath = "/tmp/hitl-escape-link";
    if (existsSync(symlinkPath)) unlinkSync(symlinkPath);
    try {
      symlinkSync("/etc", symlinkPath);

      const result = await callHandler({
        method: "tools/call",
        params: {
          name: "push_file",
          arguments: {
            local_path: join(symlinkPath, "passwd"),
            dest: "documents/passwd",
          },
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("path outside allowlist");
    } finally {
      if (existsSync(symlinkPath)) unlinkSync(symlinkPath);
    }
  });

  it("should reject destination paths containing dot (.) or dot-dot (..)", async () => {
    const callHandler = (mcp as any)._requestHandlers.get("tools/call");

    const tempFile = "/tmp/hitl-dot-dest-test.txt";
    writeFileSync(tempFile, "hello from push_file dot test", "utf8");

    try {
      // 1. dot-dot rejection
      const resDotDot = await callHandler({
        method: "tools/call",
        params: {
          name: "push_file",
          arguments: {
            local_path: tempFile,
            dest: "documents/../foo.txt",
          },
        },
      });
      expect(resDotDot.isError).toBe(true);
      expect(resDotDot.content[0].text).toContain("invalid destination path");

      // 2. single-dot rejection
      const resSingleDot = await callHandler({
        method: "tools/call",
        params: {
          name: "push_file",
          arguments: {
            local_path: tempFile,
            dest: "documents/./foo.txt",
          },
        },
      });
      expect(resSingleDot.isError).toBe(true);
      expect(resSingleDot.content[0].text).toContain("invalid destination path");
    } finally {
      if (existsSync(tempFile)) unlinkSync(tempFile);
    }
  });

  it("should succeed with an os.tmpdir() based path and invoke write_file on client for general paths", async () => {
    const callHandler = (mcp as any)._requestHandlers.get("tools/call");

    const tempFile = "/tmp/hitl-push-test.txt";
    writeFileSync(tempFile, "hello from push_file test", "utf8");

    let receivedFrame: any = null;
    const mockWs = {
      readyState: 1,
      send: (data: string) => {
        receivedFrame = JSON.parse(data);
        return true;
      },
    } as any;
    clients.add(mockWs);

    try {
      const pushPromise = callHandler({
        method: "tools/call",
        params: {
          name: "push_file",
          arguments: {
            local_path: tempFile,
            dest: "documents/foo.txt",
            overwrite: true,
            media_type: "text/javascript",
          },
        },
      });

      // Wait a tiny bit for the request to register
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedFrame).not.toBeNull();
      expect(receivedFrame.type).toBe("tool_call_request");
      expect(receivedFrame.name).toBe("write_file");
      // Arguments check
      expect(receivedFrame.arguments.path).toBe("documents/foo.txt");
      expect(receivedFrame.arguments.content).toBe("hello from push_file test");
      expect(receivedFrame.arguments.overwrite).toBe(true);
      expect(receivedFrame.arguments.media_type).toBe("text/javascript");
      expect(receivedFrame.arguments.contentType).toBe("text/javascript");

      // Resolve the waiter
      const activeId = receivedFrame.request_id;
      correlator.resolve(activeId, {
        type: "tool_call_result",
        request_id: activeId,
        success: true,
        approval: "user_approved",
        output: "Successfully wrote file to documents/foo.txt",
      });

      const result = await pushPromise;
      expect(result.isError).toBeUndefined();
      const outputObj = JSON.parse(result.content[0].text);
      expect(outputObj.success).toBe(true);
      expect(outputObj.approval).toBe("user_approved");
    } finally {
      clients.delete(mockWs);
      if (existsSync(tempFile)) unlinkSync(tempFile);
    }
  });

  it("should invoke write_skill_file on client for skills paths", async () => {
    const callHandler = (mcp as any)._requestHandlers.get("tools/call");

    const tempFile = "/tmp/hitl-skill-push-test.txt";
    writeFileSync(tempFile, "my skill script content", "utf8");

    let receivedFrame: any = null;
    const mockWs = {
      readyState: 1,
      send: (data: string) => {
        receivedFrame = JSON.parse(data);
        return true;
      },
    } as any;
    clients.add(mockWs);

    try {
      const pushPromise = callHandler({
        method: "tools/call",
        params: {
          name: "push_file",
          arguments: {
            local_path: tempFile,
            dest: "skills/my-awesome-skill/scripts/main.js",
            overwrite: false,
            media_type: "application/javascript",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedFrame).not.toBeNull();
      expect(receivedFrame.type).toBe("tool_call_request");
      expect(receivedFrame.name).toBe("write_skill_file");
      // Arguments check
      expect(receivedFrame.arguments.skillName).toBe("my-awesome-skill");
      expect(receivedFrame.arguments.filePath).toBe("scripts/main.js");
      expect(receivedFrame.arguments.file_path).toBe("scripts/main.js");
      expect(receivedFrame.arguments.filepath).toBe("scripts/main.js");
      expect(receivedFrame.arguments.content).toBe("my skill script content");
      expect(receivedFrame.arguments.overwrite).toBe(false);
      expect(receivedFrame.arguments.media_type).toBe("application/javascript");
      expect(receivedFrame.arguments.contentType).toBe("application/javascript");

      // Resolve the waiter
      const activeId = receivedFrame.request_id;
      correlator.resolve(activeId, {
        type: "tool_call_result",
        request_id: activeId,
        success: true,
        approval: "user_approved",
        output: "Successfully wrote file",
      });

      const result = await pushPromise;
      expect(result.isError).toBeUndefined();
      const outputObj = JSON.parse(result.content[0].text);
      expect(outputObj.success).toBe(true);
    } finally {
      clients.delete(mockWs);
      if (existsSync(tempFile)) unlinkSync(tempFile);
    }
  });

  it("should infer media_type from extension if omitted", async () => {
    const callHandler = (mcp as any)._requestHandlers.get("tools/call");

    const tempFile = "/tmp/hitl-infer-test.json";
    writeFileSync(tempFile, '{"hello": "world"}', "utf8");

    let receivedFrame: any = null;
    const mockWs = {
      readyState: 1,
      send: (data: string) => {
        receivedFrame = JSON.parse(data);
        return true;
      },
    } as any;
    clients.add(mockWs);

    try {
      const pushPromise = callHandler({
        method: "tools/call",
        params: {
          name: "push_file",
          arguments: {
            local_path: tempFile,
            dest: "documents/foo.json",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedFrame).not.toBeNull();
      expect(receivedFrame.type).toBe("tool_call_request");
      // Arguments check - should infer application/json
      expect(receivedFrame.arguments.media_type).toBe("application/json");
      expect(receivedFrame.arguments.contentType).toBe("application/json");

      // Resolve the waiter
      const activeId = receivedFrame.request_id;
      correlator.resolve(activeId, {
        type: "tool_call_result",
        request_id: activeId,
        success: true,
        approval: "user_approved",
        output: "Successfully wrote JSON file",
      });

      await pushPromise;
    } finally {
      clients.delete(mockWs);
      if (existsSync(tempFile)) unlinkSync(tempFile);
    }
  });
});
