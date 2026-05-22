import { describe, expect, it } from "bun:test";
import { FrameCorrelator } from "../correlator.js";
import {
  PRESENT_QUESTIONS_TOOL_DEFINITION,
  presentQuestionsToHitl,
  validateQuestionsArgs,
} from "../questions_batch.js";
import type { AuditEvent } from "../audit.js";
import type { QuestionsBatchRequestFrame } from "../types.js";

const validQuestion = () => ({
  header: "Mode",
  question: "Pick a mode",
  choices: ["A", "B"],
});

function makeHandlerDeps() {
  const correlator = new FrameCorrelator();
  const emittedFrames: Record<string, unknown>[] = [];
  const auditRows: AuditEvent[] = [];
  let nextRequestId = "req-fixed-uuid";
  const deps = {
    correlator,
    broadcastFrame: (frame: Record<string, unknown>) => {
      emittedFrames.push(frame);
      return 1;
    },
    clientsSize: () => 1,
    instanceId: "instance-test",
    generateRequestId: () => nextRequestId,
    audit: async (e: AuditEvent) => {
      auditRows.push(e);
    },
    now: () => new Date("2026-05-20T00:00:00.000Z"),
    setRequestId: (id: string) => {
      nextRequestId = id;
    },
  };
  return { correlator, emittedFrames, auditRows, deps };
}

describe("validateQuestionsArgs", () => {
  it("rejects empty questions list", () => {
    const r = validateQuestionsArgs({ questions: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least/);
  });

  it("rejects > 4 questions", () => {
    const r = validateQuestionsArgs({
      questions: [validQuestion(), validQuestion(), validQuestion(), validQuestion(), validQuestion()],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exceeds max length 4/);
  });

  it("rejects < 2 choices", () => {
    const r = validateQuestionsArgs({
      questions: [{ ...validQuestion(), choices: ["only"] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/choices must have at least 2/);
  });

  it("rejects > 4 choices", () => {
    const r = validateQuestionsArgs({
      questions: [
        { ...validQuestion(), choices: ["a", "b", "c", "d", "e"] },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/choices exceeds max length 4/);
  });

  it("rejects header longer than 12 chars", () => {
    const r = validateQuestionsArgs({
      questions: [{ ...validQuestion(), header: "WayTooLongHeaderHere" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/header exceeds max length 12/);
  });

  it("accepts a well-formed batch with multi_select + allow_other", () => {
    const r = validateQuestionsArgs({
      questions: [
        {
          header: "Mode",
          question: "Pick a mode",
          choices: ["A", "B"],
          multi_select: true,
          allow_other: true,
        },
      ],
      timeout_seconds: 30,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.questions.length).toBe(1);
      expect(r.questions[0]!.multi_select).toBe(true);
      expect(r.questions[0]!.allow_other).toBe(true);
      expect(r.timeoutSeconds).toBe(30);
    }
  });

  it("clamps timeout to hard cap 900s", () => {
    const r = validateQuestionsArgs({
      questions: [validQuestion()],
      timeout_seconds: 99999,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.timeoutSeconds).toBe(900);
  });
});

describe("PRESENT_QUESTIONS_TOOL_DEFINITION", () => {
  it("exposes the schema constraints expected by SPEC-HC-004 AV1", () => {
    const def = PRESENT_QUESTIONS_TOOL_DEFINITION;
    expect(def.name).toBe("present_questions_to_hitl");
    expect(def.inputSchema.properties.questions.minItems).toBe(1);
    expect(def.inputSchema.properties.questions.maxItems).toBe(4);
    const item = def.inputSchema.properties.questions.items;
    expect(item.properties.choices.minItems).toBe(2);
    expect(item.properties.choices.maxItems).toBe(4);
    expect(item.properties.header.maxLength).toBe(12);
  });
});

describe("presentQuestionsToHitl handler (SPEC-AW-311 fire-and-forget)", () => {
  it("happy-path: dispatches one frame, returns immediately, registers no waiter", async () => {
    const { correlator, emittedFrames, auditRows, deps } = makeHandlerDeps();

    const result = await presentQuestionsToHitl(
      { questions: [validQuestion()] },
      deps,
    );

    // Fire-and-forget: handler returns before any phone reply.
    expect(emittedFrames.length).toBe(1);
    const frame = emittedFrames[0] as unknown as QuestionsBatchRequestFrame;
    expect(frame.type).toBe("questions_batch_request");
    expect(frame.request_id).toBe("req-fixed-uuid");
    expect(frame.questions.length).toBe(1);
    // No correlator waiter is registered — answers flow back as a normal
    // channel notification rather than via a synchronous round-trip.
    expect(correlator.size).toBe(0);

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/Survey presented/);
    expect(result.content[0]!.text).toMatch(/req-fixed-uuid/);

    // Dispatch-side audit row still emits with the closed-schema shape.
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]!.direction).toBe("cc_to_phone");
    expect(auditRows[0]!.kind).toBe("questions_batch");
    expect(auditRows[0]!.tool_name).toBeNull();
    expect(auditRows[0]!.attachment_count).toBe(0);
    expect(auditRows[0]!.attachment_bytes).toBe(0);
    expect(auditRows[0]!.prompt_hash.length).toBe(64);
  });

  it("returns no_phone_connected error when broadcastFrame delivers to zero clients", async () => {
    const { correlator, emittedFrames, deps } = makeHandlerDeps();
    // Override broadcastFrame to simulate zero delivery (phone disconnected
    // after the clientsSize() pre-check).
    deps.broadcastFrame = (frame) => {
      emittedFrames.push(frame);
      return 0;
    };
    const result = await presentQuestionsToHitl(
      { questions: [validQuestion()] },
      deps,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/no_phone_connected/);
    expect(correlator.size).toBe(0);
  });

  it("returns an error and skips dispatch when no phone is connected", async () => {
    const { emittedFrames, deps } = makeHandlerDeps();
    deps.clientsSize = () => 0;
    const result = await presentQuestionsToHitl(
      { questions: [validQuestion()] },
      deps,
    );
    expect(result.isError).toBe(true);
    expect(emittedFrames.length).toBe(0);
  });

  it("rejects malformed input with no frame emitted", async () => {
    const { emittedFrames, deps } = makeHandlerDeps();
    const result = await presentQuestionsToHitl({ questions: [] }, deps);
    expect(result.isError).toBe(true);
    expect(emittedFrames.length).toBe(0);
  });
});
