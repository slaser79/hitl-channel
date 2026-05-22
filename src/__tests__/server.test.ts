import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { startHttpBridge } from "../http_bridge.js";

const TEST_PORT = 8790;
const TEST_API_KEY = "test-key";

describe("hitl-channel HTTP Bridge", () => {
  let mcpMock: Server;
  let server: any;
  let lastNotification: any = null;

  beforeAll(() => {
    process.env.HITL_CHANNEL_PORT = TEST_PORT.toString();
    process.env.HITL_CHANNEL_API_KEY = TEST_API_KEY;

    mcpMock = {
      notification: async (notif: any) => {
        lastNotification = notif;
      },
    } as any;

    server = startHttpBridge(mcpMock);
  });

  afterAll(() => {
    server.stop();
  });

  it("GET /health should return 200 OK", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
  });

  it("POST / without auth should return 401 Unauthorized", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
    });
    expect(response.status).toBe(401);
  });

  it("POST / with valid auth should return 200 Delivered", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "hello from test" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("delivered");
  });

  it("POST / should forward metadata to mcp.notification", async () => {
    lastNotification = null;
    const payload = {
      message: "Submitted 3 answers",
      metadata: {
        type: "questions_batch_response",
        batch_id: "req-123",
        batch_answer: { answers: [{ header: "H1", selected: ["A"] }], cancelled: false }
      }
    };

    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(lastNotification).not.toBeNull();
    expect(lastNotification.params.content).toBe("Submitted 3 answers");
    expect(lastNotification.params.meta.type).toBe("questions_batch_response");
    expect(lastNotification.params.meta.batch_id).toBe("req-123");
    // Verify batch_id -> request_id mapping
    expect(lastNotification.params.meta.request_id).toBe("req-123");
    expect(JSON.parse(lastNotification.params.meta.batch_answer)).toEqual(payload.metadata.batch_answer);
  });

  it("POST / with empty message should return 400 Bad Request", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "" }),
    });
    expect(response.status).toBe(400);
  });

  it("WebSocket should connect and receive replies", async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws?api_key=${TEST_API_KEY}`);
      
      ws.onopen = () => {
        import("../http_bridge.js").then(({ broadcastReply }) => {
          broadcastReply("test reply", "msg1", "agent1");
        });
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data.toString());
          expect(data.type).toBe("reply");
          expect(data.text).toBe("test reply");
          expect(data.message_id).toBe("msg1");
          expect(data.agent_id).toBe("agent1");
          ws.close();
          resolve();
        } catch (err) {
          ws.close();
          reject(err);
        }
      };

      ws.onerror = (err) => {
        reject(err);
      };
    });
  });
});
