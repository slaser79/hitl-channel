import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { readFile } from "node:fs/promises";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  clients,
  correlator,
  broadcastReply,
  unicastFrame,
  unicastCorrelatedFrame,
} from "../http_bridge.js";
import { mcp } from "../server.js";
import { presentQuestionsToHitl } from "../questions_batch.js";
import type { HitlWebSocket, ToolCallResultFrame } from "../types.js";
import { auditDir } from "../audit.js";

function getCallHandler() {
  const handler = (mcp as any)._requestHandlers.get("tools/call");
  if (!handler) throw new Error("tools/call handler not registered on mcp server");
  return (name: string, args: Record<string, unknown> = {}) =>
    handler({
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    });
}

function createMockSocket(tokenHash: string, lastSeenMs: number): HitlWebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    data: {
      tokenHash,
      connectedAt: new Date(lastSeenMs - 10000).toISOString(),
      lastSeen: new Date(lastSeenMs).toISOString(),
    },
    readyState: 1,
    send(data: string) {
      sent.push(data);
      return 1;
    },
    sent,
  };
}

async function waitForFrames(a: { sent: string[] }, b: { sent: string[] }, expectedTotal: number) {
  for (let i = 0; i < 200; i++) {
    if (a.sent.length + b.sent.length >= expectedTotal) break;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Multi-device routing and arbitration (Issue #40)", () => {
  beforeEach(() => {
    delete process.env.HITL_CHANNEL_ATTACHMENT_ROOTS;
    clients.clear();
    correlator.rejectAll(new Error("test cleanup"));
  });

  afterEach(() => {
    clients.clear();
    correlator.rejectAll(new Error("test cleanup"));
  });

  it("AV1: Two-client harness attaches identity and enables distinct device tracking", () => {
    const clientA = createMockSocket("hash-device-A", Date.now() - 5000);
    const clientB = createMockSocket("hash-device-B", Date.now());

    clients.add(clientA);
    clients.add(clientB);

    expect(clients.size).toBe(2);
    expect(clientA.data?.tokenHash).toBe("hash-device-A");
    expect(clientB.data?.tokenHash).toBe("hash-device-B");
  });

  it("AV2: CLASS A — chat frames (reply_to_hitl / broadcastReply) reach BOTH connected clients", () => {
    const clientA = createMockSocket("hash-device-A", Date.now() - 5000);
    const clientB = createMockSocket("hash-device-B", Date.now());
    clients.add(clientA);
    clients.add(clientB);

    broadcastReply("Hello both phones!");

    expect(clientA.sent.length).toBe(1);
    expect(clientB.sent.length).toBe(1);

    const msgA = JSON.parse(clientA.sent[0]!);
    const msgB = JSON.parse(clientB.sent[0]!);
    expect(msgA.type).toBe("reply");
    expect(msgA.text).toBe("Hello both phones!");
    expect(msgB.type).toBe("reply");
    expect(msgB.text).toBe("Hello both phones!");
  });

  it("AV3a: call_phone_tool sends tool_call_request to unicast target", async () => {
    const callTool = getCallHandler();
    const clientA = createMockSocket("hash-device-A", Date.now() - 5000);
    const clientB = createMockSocket("hash-device-B", Date.now());
    clients.add(clientA);
    clients.add(clientB);

    const callPromise = callTool("call_phone_tool", {
      name: "get_automation",
      arguments: { id: "auto-1" },
    });
    await waitForFrames(clientA, clientB, 1);
    expect(clientA.sent.length).toBe(0);
    expect(clientB.sent.length).toBe(1);
    const req1 = JSON.parse(clientB.sent[0]!);
    expect(req1.type).toBe("tool_call_request");
    correlator.resolve(req1.request_id, {
      type: "tool_call_result",
      request_id: req1.request_id,
      success: true,
      output: { id: "auto-1", name: "test" },
    }, "hash-device-B");
    await callPromise;
  });

  it("AV3b: push_file sends tool_call_request to unicast target", async () => {
    const callTool = getCallHandler();
    const clientA = createMockSocket("hash-device-A", Date.now() - 5000);
    const clientB = createMockSocket("hash-device-B", Date.now());
    clients.add(clientA);
    clients.add(clientB);

    const tmpFile = join(homedir(), "hitl-multi-push-test.txt");
    writeFileSync(tmpFile, "hello from push_file test", "utf8");
    process.env.HITL_CHANNEL_ATTACHMENT_ROOTS = `${homedir()}:${tmpdir()}:/tmp`;
    try {
      const pushPromise = callTool("push_file", {
        local_path: tmpFile,
        dest: "documents/test.txt",
      });
      await waitForFrames(clientA, clientB, 1);
      expect(clientA.sent.length).toBe(0);
      expect(clientB.sent.length).toBe(1);
      const req2 = JSON.parse(clientB.sent[0]!);
      expect(req2.type).toBe("tool_call_request");
      expect(req2.name).toBe("write_file");
      correlator.resolve(req2.request_id, {
        type: "tool_call_result",
        request_id: req2.request_id,
        success: true,
      }, "hash-device-B");
      await pushPromise;
    } finally {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    }
  });

  it("AV3c: list_phone_tools sends list_tools_request to unicast target", async () => {
    const callTool = getCallHandler();
    const clientA = createMockSocket("hash-device-A", Date.now() - 5000);
    const clientB = createMockSocket("hash-device-B", Date.now());
    clients.add(clientA);
    clients.add(clientB);

    const listPromise = callTool("list_phone_tools", {});
    await waitForFrames(clientA, clientB, 1);
    expect(clientA.sent.length).toBe(0);
    expect(clientB.sent.length).toBe(1);
    const req3 = JSON.parse(clientB.sent[0]!);
    expect(req3.type).toBe("list_tools_request");
    correlator.resolve(req3.request_id, {
      type: "list_tools_result",
      request_id: req3.request_id,
      tools: [],
    }, "hash-device-B");
    await listPromise;
  });

  it("AV3d: present_questions_to_hitl sends questions_batch_request to unicast target", async () => {
    const clientA = createMockSocket("hash-device-A", Date.now() - 5000);
    const clientB = createMockSocket("hash-device-B", Date.now());
    clients.add(clientA);
    clients.add(clientB);

    await presentQuestionsToHitl(
      {
        questions: [
          { header: "Q1", question: "Option?", choices: ["A", "B"] },
        ],
      },
      {
        correlator,
        unicastFrame,
        clientsSize: () => clients.size,
        instanceId: "test-instance",
        generateRequestId: () => "req-q1",
        audit: async () => {},
      },
    );
    expect(clientA.sent.length).toBe(0);
    expect(clientB.sent.length).toBe(1);
    const req4 = JSON.parse(clientB.sent[0]!);
    expect(req4.type).toBe("questions_batch_request");
  });

  it("AV3e: present_choices_to_hitl sends choices frame to unicast target", async () => {
    const callTool = getCallHandler();
    const clientA = createMockSocket("hash-device-A", Date.now() - 5000);
    const clientB = createMockSocket("hash-device-B", Date.now());
    clients.add(clientA);
    clients.add(clientB);

    await callTool("present_choices_to_hitl", {
      prompt: "Pick one",
      choices: ["Choice 1", "Choice 2"],
    });
    expect(clientA.sent.length).toBe(0);
    expect(clientB.sent.length).toBe(1);
    const req5 = JSON.parse(clientB.sent[0]!);
    expect(req5.type).toBe("choices");
  });

  it("AV5: The grep invariant holds — for (const ws of clients) appears ONLY in broadcastReply", async () => {
    const bridgeSrc = await readFile("src/http_bridge.ts", "utf8");
    const serverSrc = await readFile("src/server.ts", "utf8");
    const batchSrc = await readFile("src/questions_batch.ts", "utf8");

    const allCode = `${bridgeSrc}\n${serverSrc}\n${batchSrc}`;
    const matches = allCode.match(/for\s*\(\s*const\s+\w+\s+of\s+clients\s*\)/g) ?? [];

    expect(matches.length).toBe(1);
  });

  it("AV6 & AV7: Late/second response cannot alter settled result & deny-fast-path race is removed", async () => {
    const callTool = getCallHandler();
    const clientA = createMockSocket("hash-device-A", Date.now());
    const clientB = createMockSocket("hash-device-B", Date.now() - 5000);
    clients.add(clientA);
    clients.add(clientB);

    const callPromise = callTool("call_phone_tool", {
      name: "trigger_automation",
      arguments: { id: "auto-42" },
    });
    await waitForFrames(clientA, clientB, 1);

    // Verify request frame went ONLY to clientA (most active)
    expect(clientA.sent.length).toBe(1);
    expect(clientB.sent.length).toBe(0);

    const req = JSON.parse(clientA.sent[0]!);
    const reqId = req.request_id;

    // Simulate clientB trying to send an unsolicited fast-deny frame
    const unsolicitedDeny: ToolCallResultFrame = {
      type: "tool_call_result",
      request_id: reqId,
      success: false,
      error: "User denied execution",
      approval: "user_denied",
    };

    const clientAResult: ToolCallResultFrame = {
      type: "tool_call_result",
      request_id: reqId,
      success: true,
      output: { status: "executed" },
      approval: "user_approved",
    };

    // Client A responds with approval
    const resolvedA = correlator.resolve(reqId, clientAResult, "hash-device-A");
    expect(resolvedA).toBe(true);

    // Client B's late/unsolicited response fails to resolve
    const resolvedB = correlator.resolve(reqId, unsolicitedDeny, "hash-device-B");
    expect(resolvedB).toBe(false);

    const res = await callPromise;
    expect(res.isError).toBeUndefined();
    expect(JSON.stringify(res.content)).toContain("user_approved");
  });

  it("Target device verification: non-target senderDeviceId cannot resolve correlator waiter", async () => {
    const waiter = correlator.register("req-123", 1000, "hash-device-A");
    // Client B tries to resolve
    const resB = correlator.resolve("req-123", { success: true }, "hash-device-B");
    expect(resB).toBe(false);

    // Client A resolves
    const resA = correlator.resolve("req-123", { success: true }, "hash-device-A");
    expect(resA).toBe(true);
    const result = await waiter;
    expect(result).toEqual({ success: true });
  });

  it("registers the selected device before sending on that same socket", async () => {
    const requestId = "req-sync-response";
    const clientA = createMockSocket("hash-device-A", Date.now());
    const clientB = createMockSocket("hash-device-B", Date.now() - 5000);
    clientA.send = (data: string) => {
      clientA.sent.push(data);
      // Simulate another device becoming most-active and the target replying
      // synchronously during send.
      clientB.data!.lastSeen = new Date(Date.now() + 1000).toISOString();
      expect(correlator.getTargetDevice(requestId)).toBe("hash-device-A");
      correlator.resolve(requestId, { success: true }, "hash-device-A");
      return 1;
    };
    clients.add(clientA);
    clients.add(clientB);

    const dispatch = unicastCorrelatedFrame<{ success: boolean }>(
      { type: "tool_call_request", request_id: requestId },
      requestId,
      1000,
    );

    expect(dispatch.delivered).toBe(true);
    if (!dispatch.delivered) throw new Error(dispatch.error);
    expect(dispatch.targetDevice).toBe("hash-device-A");
    expect(await dispatch.waiter).toEqual({ success: true });
    expect(clientA.sent.length).toBe(1);
    expect(clientB.sent.length).toBe(0);
  });

  it("AV8: Read-after-write coherence — write then read resolve to the same active device", async () => {
    const callTool = getCallHandler();
    const clientA = createMockSocket("hash-device-A", Date.now() - 10000);
    const clientB = createMockSocket("hash-device-B", Date.now());
    clients.add(clientA);
    clients.add(clientB);

    // Write call
    const writePromise = callTool("call_phone_tool", {
      name: "save_automation",
      arguments: { name: "My Task" },
    });
    await waitForFrames(clientA, clientB, 1);
    expect(clientB.sent.length).toBe(1);
    const writeReq = JSON.parse(clientB.sent[0]!);
    correlator.resolve(writeReq.request_id, {
      type: "tool_call_result",
      request_id: writeReq.request_id,
      success: true,
      output: { id: "created-101" },
    }, "hash-device-B");
    await writePromise;

    // Read call
    const readPromise = callTool("call_phone_tool", {
      name: "get_automation",
      arguments: { id: "created-101" },
    });
    await waitForFrames(clientA, clientB, 2);
    expect(clientB.sent.length).toBe(2);
    const readReq = JSON.parse(clientB.sent[1]!);
    correlator.resolve(readReq.request_id, {
      type: "tool_call_result",
      request_id: readReq.request_id,
      success: true,
      output: { id: "created-101", name: "My Task" },
    }, "hash-device-B");
    await readPromise;

    // Both calls landed on clientB
    expect(clientA.sent.length).toBe(0);
  });

  it("AV9: No silent re-broadcast on timeout — names target device & does not fall back to other device", async () => {
    const callTool = getCallHandler();
    const clientA = createMockSocket("hash-device-A", Date.now());
    const clientB = createMockSocket("hash-device-B", Date.now() - 5000);
    clients.add(clientA);
    clients.add(clientB);

    // Call with short timeout (0.1 seconds)
    const callPromise = callTool("call_phone_tool", {
      name: "silent_tool",
      timeout_seconds: 0.1,
    });

    const res = await callPromise;
    expect(res.isError).toBe(true);
    const errText = (res.content[0] as { text: string }).text;
    expect(errText).toContain("timeout");
    expect(errText).toContain("hash-device-A");

    // Assert request was delivered to clientA and NEVER re-broadcasted to clientB
    expect(clientA.sent.length).toBe(1);
    expect(clientB.sent.length).toBe(0);
  });

  it("AV10: list_devices enumerates devices and device parameter overrides active heuristic", async () => {
    const callTool = getCallHandler();
    const clientA = createMockSocket("hash-device-A", Date.now() - 5000);
    const clientB = createMockSocket("hash-device-B", Date.now());
    clients.add(clientA);
    clients.add(clientB);

    // Test list_devices
    const listRes = await callTool("list_devices", {});
    const listData = JSON.parse((listRes.content[0] as { text: string }).text);
    expect(listData.devices.length).toBe(2);
    expect(listData.devices[0].token_hash).toBe("hash-device-A");
    expect(listData.devices[1].token_hash).toBe("hash-device-B");
    expect(listData.devices[1].is_active).toBe(true);

    // Target clientA explicitly even though clientB is more active
    const callPromise = callTool("call_phone_tool", {
      name: "targeted_action",
      device: "hash-device-A",
    });
    await waitForFrames(clientA, clientB, 1);

    expect(clientA.sent.length).toBe(1);
    expect(clientB.sent.length).toBe(0);
    const req = JSON.parse(clientA.sent[0]!);
    correlator.resolve(req.request_id, {
      type: "tool_call_result",
      request_id: req.request_id,
      success: true,
    }, "hash-device-A");
    await callPromise;

    // Unknown device returns error
    const unknownRes = await callTool("call_phone_tool", {
      name: "invalid_target",
      device: "nonexistent-device",
    });
    expect(unknownRes.isError).toBe(true);
    expect((unknownRes.content[0] as { text: string }).text).toContain("device 'nonexistent-device' not found");
  });

  it("AV11: Observability — audit events record device_id for calls and timeouts", async () => {
    const callTool = getCallHandler();
    const clientA = createMockSocket("hash-device-A", Date.now());
    clients.add(clientA);

    const callPromise = callTool("call_phone_tool", {
      name: "timeout_tool",
      timeout_seconds: 0.1,
    });
    await callPromise;

    // Give audit append a moment
    await new Promise((r) => setTimeout(r, 50));

    const todayStr = new Date().toISOString().slice(0, 10);
    const auditFile = join(auditDir, `${todayStr}.jsonl`);
    const content = await readFile(auditFile, "utf8");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));

    const timeoutLine = lines.find((l) => l.tool_name === "timeout_tool" && l.approval === "timeout");
    expect(timeoutLine).toBeDefined();
    expect(timeoutLine.device_id).toBe("hash-device-A");
  });
});
