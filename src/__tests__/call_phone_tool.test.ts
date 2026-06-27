import { describe, expect, it } from "bun:test";
import { mcp } from "../server.js";
import { clients, correlator } from "../http_bridge.js";

describe("call_phone_tool", () => {
  it("should relay result.data in its response when present on success", async () => {
    const callHandler = (mcp as any)._requestHandlers.get("tools/call");
    expect(callHandler).toBeDefined();

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
      const callPromise = callHandler({
        method: "tools/call",
        params: {
          name: "call_phone_tool",
          arguments: {
            name: "get_agent_definition",
            arguments: {
              agent_id: "family-coordinator"
            }
          }
        }
      });

      // Wait for the request to register
      for (let i = 0; i < 100 && !receivedFrame; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(receivedFrame).not.toBeNull();
      expect(receivedFrame.type).toBe("tool_call_request");
      expect(receivedFrame.name).toBe("get_agent_definition");

      // Resolve the waiter via correlator with a structured 'data' object
      const activeId = receivedFrame.request_id;
      correlator.resolve(activeId, {
        type: "tool_call_result",
        request_id: activeId,
        success: true,
        approval: "user_approved",
        output: "Retrieved agent definition for \"Family Coordinator\".",
        data: {
          skills: ["a", "b"],
          system_prompt: "Coordinate family events"
        }
      });

      const result = await callPromise;
      expect(result.isError).toBeUndefined();
      const outputObj = JSON.parse(result.content[0].text);
      expect(outputObj.success).toBe(true);
      expect(outputObj.output).toBe("Retrieved agent definition for \"Family Coordinator\".");
      expect(outputObj.approval).toBe("user_approved");
      expect(outputObj.data).toEqual({
        skills: ["a", "b"],
        system_prompt: "Coordinate family events"
      });
    } finally {
      clients.delete(mockWs);
    }
  });

  it("should support success cases where data is absent (existing relays unaffected)", async () => {
    const callHandler = (mcp as any)._requestHandlers.get("tools/call");

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
      const callPromise = callHandler({
        method: "tools/call",
        params: {
          name: "call_phone_tool",
          arguments: {
            name: "simple_tool",
            arguments: {}
          }
        }
      });

      for (let i = 0; i < 100 && !receivedFrame; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const activeId = receivedFrame.request_id;
      correlator.resolve(activeId, {
        type: "tool_call_result",
        request_id: activeId,
        success: true,
        approval: "auto",
        output: "simple output"
      });

      const result = await callPromise;
      expect(result.isError).toBeUndefined();
      const outputObj = JSON.parse(result.content[0].text);
      expect(outputObj.success).toBe(true);
      expect(outputObj.output).toBe("simple output");
      expect(outputObj.data).toBeNull();
    } finally {
      clients.delete(mockWs);
    }
  });

  it("should relay result.data in its response when present on failure", async () => {
    const callHandler = (mcp as any)._requestHandlers.get("tools/call");

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
      const callPromise = callHandler({
        method: "tools/call",
        params: {
          name: "call_phone_tool",
          arguments: {
            name: "failing_tool",
            arguments: {}
          }
        }
      });

      for (let i = 0; i < 100 && !receivedFrame; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const activeId = receivedFrame.request_id;
      correlator.resolve(activeId, {
        type: "tool_call_result",
        request_id: activeId,
        success: false,
        error: "Some error occurred",
        data: {
          partial_result: "some data"
        }
      });

      const result = await callPromise;
      expect(result.isError).toBe(true);
      const outputObj = JSON.parse(result.content[0].text);
      expect(outputObj.success).toBe(false);
      expect(outputObj.error).toBe("Some error occurred");
      expect(outputObj.data).toEqual({
        partial_result: "some data"
      });
    } finally {
      clients.delete(mockWs);
    }
  });
});
