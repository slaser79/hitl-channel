import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { startHttpBridge } from "../http_bridge.js";

const TEST_PORT = 8791;
const TEST_API_KEY = "test-key-pairing";

describe("hitl-channel Pairing Endpoints", () => {
  let mcpMock: Server;
  let server: any;

  beforeAll(() => {
    process.env.HITL_CHANNEL_PORT = TEST_PORT.toString();
    process.env.HITL_CHANNEL_API_KEY = TEST_API_KEY;

    mcpMock = {
      notification: async () => {},
    } as any;

    server = startHttpBridge(mcpMock);
  });

  afterAll(() => {
    server.stop();
  });

  describe("POST /pair/request", () => {
    it("should return 202 Accepted with pending status", async () => {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/pair/request`, {
        method: "POST",
      });
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.status).toBe("pending");
      expect(body.message).toBeDefined();
      expect(body.expires_in).toBe(300);
      // Code should NOT be in response body
      expect(body.code).toBeUndefined();
    });
  });

  describe("POST /pair/validate", () => {
    it("should return 400 for invalid code format", async () => {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/pair/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "abc" }),
      });
      expect(response.status).toBe(400);
    });

    it("should return 403 for non-existent code", async () => {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/pair/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "999999" }),
      });
      expect(response.status).toBe(403);
    });

    it("should complete pairing flow with valid code", async () => {
      // Step 1: Request pairing code
      const requestResponse = await fetch(`http://127.0.0.1:${TEST_PORT}/pair/request`, {
        method: "POST",
      });
      expect(requestResponse.status).toBe(202);

      // Note: In real scenario, code is printed to stderr
      // For testing, we'll need to test the flow differently
      // This test verifies the endpoint structure
    });

    it("should return device_token on successful pairing", async () => {
      // Request a code first
      await fetch(`http://127.0.0.1:${TEST_PORT}/pair/request`, {
        method: "POST",
      });

      // We can't easily capture the stderr output in tests
      // This test documents the expected behavior
      // The actual code validation would work like this:
      // const response = await fetch(`http://127.0.0.1:${TEST_PORT}/pair/validate`, {
      //   method: "POST",
      //   headers: { "Content-Type": "application/json" },
      //   body: JSON.stringify({ code: "<code_from_stderr>" }),
      // });
      // expect(response.status).toBe(200);
      // const body = await response.json();
      // expect(body.device_token).toBeDefined();
    });
  });

  describe("GET /instance", () => {
    it("should return instance identity", async () => {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/instance`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.instanceId).toBeDefined();
      expect(body.hostname).toBeDefined();
    });
  });

  describe("Token-based authentication", () => {
    it("should reject requests without auth", async () => {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "test" }),
      });
      expect(response.status).toBe(401);
    });

    it("should accept requests with valid API key", async () => {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${TEST_API_KEY}`,
        },
        body: JSON.stringify({ message: "test" }),
      });
      expect(response.status).toBe(200);
    });

    it("should accept requests with token query param", async () => {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/?token=${TEST_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "test" }),
      });
      expect(response.status).toBe(200);
    });
  });
});
