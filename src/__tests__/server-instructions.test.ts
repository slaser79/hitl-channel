// SPEC-HITL-CC-001 Phase 3 (issue hitl-app#4010) — AC#23a snapshot:
// the workflow-delegation final-reply ceremony paragraph is part of the
// MCP `serverInfo.instructions` field every connecting CC session
// observes on `initialize`.
//
// We import the composed `MCP_INSTRUCTIONS` constant rather than spinning
// up the full MCP server. The Server constructor stores `instructions`
// opaquely (no `getInstructions` accessor in the public SDK), so the
// constant is the load-bearing surface — if it ever stops including the
// ceremony, every CC connecting to a workflow-delegating phone silently
// misses the contract.
import { describe, expect, it } from "bun:test";
import {
  MCP_INSTRUCTIONS,
  WORKFLOW_DELEGATION_CEREMONY,
} from "../mcp_instructions.js";

describe("MCP instructions — SPEC-HITL-CC-001 Phase 3", () => {
  it("includes the workflow-delegation final-reply ceremony", () => {
    expect(MCP_INSTRUCTIONS).toContain(WORKFLOW_DELEGATION_CEREMONY);
  });

  it("names the <workflow_delegation message_id=X> envelope tag", () => {
    expect(MCP_INSTRUCTIONS).toContain("<workflow_delegation message_id=X>");
  });

  it("requires exactly one reply_to_hitl call per delegation", () => {
    expect(MCP_INSTRUCTIONS).toContain(
      "reply_to_hitl(message_id=X, content=<your final answer>)"
    );
    expect(MCP_INSTRUCTIONS).toContain("EXACTLY ONCE");
  });

  it("describes the drop-intermediates contract", () => {
    expect(MCP_INSTRUCTIONS).toContain(
      "Intermediate calls to `reply_to_hitl(message_id=X, …)` for the same X are"
    );
    expect(MCP_INSTRUCTIONS).toContain(
      "dropped by the waiter — only the first matching reply resolves"
    );
  });
});
