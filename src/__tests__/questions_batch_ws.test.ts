import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { correlator, startHttpBridge } from "../http_bridge.js";
import type { QuestionsBatchResultFrame } from "../types.js";

const TEST_PORT = 8794;
const TEST_API_KEY = "test-key-qb";

describe("hitl-channel WS routing for SPEC-HC-004", () => {
  let mcpMock: Server;
  let server: ReturnType<typeof startHttpBridge>;

  beforeAll(() => {
    process.env.HITL_CHANNEL_PORT = TEST_PORT.toString();
    process.env.HITL_CHANNEL_API_KEY = TEST_API_KEY;
    process.env.HITL_INSTANCE_ID = "instance-test-ws";
    mcpMock = { notification: async () => {} } as unknown as Server;
    server = startHttpBridge(mcpMock);
  });

  afterAll(() => {
    server.stop(true);
  });

  async function openWS(): Promise<WebSocket> {
    const ws = new WebSocket(
      `ws://127.0.0.1:${TEST_PORT}/ws?api_key=${TEST_API_KEY}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
    return ws;
  }

  it("AV8: well-formed questions_batch_result resolves the waiter", async () => {
    const ws = await openWS();
    try {
      const requestId = `req-${Date.now()}`;
      const waiter = correlator.register<QuestionsBatchResultFrame>(
        requestId,
        5_000,
      );
      const frame: QuestionsBatchResultFrame = {
        type: "questions_batch_result",
        request_id: requestId,
        answers: [{ header: "Mode", selected: ["A"] }],
        cancelled: false,
      };
      ws.send(JSON.stringify(frame));
      const result = await waiter;
      expect(result.type).toBe("questions_batch_result");
      expect(result.answers[0]!.selected).toEqual(["A"]);
      expect(correlator.size).toBe(0);
    } finally {
      ws.close();
    }
  });

  it("AV8: malformed questions_batch_result (missing answers) is dropped, waiter not resolved", async () => {
    const ws = await openWS();
    try {
      const requestId = `req-bad-${Date.now()}`;
      const waiter = correlator.register<QuestionsBatchResultFrame>(
        requestId,
        200,
      );
      ws.send(
        JSON.stringify({
          type: "questions_batch_result",
          request_id: requestId,
          // answers intentionally missing
          cancelled: false,
        }),
      );
      // Give the WS handler a moment to process; the waiter must NOT resolve.
      await new Promise((r) => setTimeout(r, 50));
      expect(correlator.size).toBe(1);
      // Eventually timeout fires (~200ms after register) — confirm it rejects.
      await expect(waiter).rejects.toThrow(/timeout/);
    } finally {
      ws.close();
    }
  });

  it("AV4 (deviation): with no WS client connected, present_questions_to_hitl handler short-circuits with isError — frame is NOT buffered (matches call_phone_tool semantics; ReplyBuffer accepts ReplyPayload only)", async () => {
    // No WS client opened in this test — relies on handler-level guard.
    // This documents the deviation from the spec's AV4 wording.
    const { presentQuestionsToHitl } = await import("../questions_batch.js");
    const { FrameCorrelator } = await import("../correlator.js");
    const result = await presentQuestionsToHitl(
      { questions: [{ header: "Mode", question: "Q", choices: ["A", "B"] }] },
      {
        correlator: new FrameCorrelator(),
        broadcastFrame: () => 0,
        clientsSize: () => 0,
        instanceId: "test",
        generateRequestId: () => "id",
      },
    );
    expect(result.isError).toBe(true);
  });
});
