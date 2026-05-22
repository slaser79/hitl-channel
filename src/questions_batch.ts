/**
 * SPEC-HC-004 — `present_questions_to_hitl` MCP tool handler.
 *
 * Fire-and-forget dispatch sibling of `present_choices_to_hitl`
 * (server.ts:383). Generate UUID, emit closed-schema dispatch audit row,
 * broadcast one WS frame to the phone, return immediately. The user's
 * submitted answers arrive on a later agent turn as a normal channel
 * notification carrying the same `request_id` — callers can correlate
 * by that id if they care.
 *
 * Previous design (SPEC-AW-311 v1) registered a correlator waiter and
 * blocked the MCP call until the phone returned a `questions_batch_result`
 * WS frame. That path doesn't work in practice: the phone-side response
 * goes via HTTP POST to `/` (notification surface), never reaches the
 * correlator, so the waiter sat blocked until `timeout_seconds` elapsed.
 *
 * Extracted from server.ts so the validation + dispatch logic is unit-testable
 * without booting the stdio MCP transport (server.ts has a top-level
 * `await mcp.connect(...)`).
 */
import { appendAudit, sha256Hex } from "./audit.js";
import type { FrameCorrelator } from "./correlator.js";
import type {
  QuestionSpec,
  QuestionsBatchRequestFrame,
} from "./types.js";

const MAX_QUESTIONS = 4;
const MIN_QUESTIONS = 1;
const MIN_CHOICES = 2;
const MAX_CHOICES = 4;
const MAX_HEADER_LEN = 12;
const MAX_QUESTION_LEN = 1000;
const DEFAULT_TIMEOUT_S = 300;
const HARD_CAP_TIMEOUT_S = 900;

export const PRESENT_QUESTIONS_TOOL_DEFINITION = {
  name: "present_questions_to_hitl",
  description:
    "Pose 1–4 related questions to the paired HITL phone user in a single " +
    "round-trip. Returns one structured `{answers, cancelled}` payload. " +
    "LAN-path sibling of the cloud relay's `request_human_input_multiple`. " +
    "Each QuestionSpec has {header (≤12 chars), question (≤1000 chars), " +
    "choices (2–4 strings), optional multi_select, optional allow_other}.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: MIN_QUESTIONS,
        maxItems: MAX_QUESTIONS,
        items: {
          type: "object",
          properties: {
            header: { type: "string", maxLength: MAX_HEADER_LEN },
            question: { type: "string", maxLength: MAX_QUESTION_LEN },
            choices: {
              type: "array",
              minItems: MIN_CHOICES,
              maxItems: MAX_CHOICES,
              items: { type: "string" },
            },
            multi_select: { type: "boolean" },
            allow_other: { type: "boolean" },
          },
          required: ["header", "question", "choices"],
        },
      },
      timeout_seconds: {
        type: "number",
        description: `Round-trip timeout. Default ${DEFAULT_TIMEOUT_S}, hard cap ${HARD_CAP_TIMEOUT_S}.`,
      },
    },
    required: ["questions"],
  },
} as const;

export type ValidationResult =
  | { ok: true; questions: QuestionSpec[]; timeoutSeconds: number }
  | { ok: false; error: string };

/**
 * Validate raw MCP arguments into a normalised QuestionSpec[]. MCP SDK schema
 * validation alone is not relied upon — we enforce the constraints here so a
 * malformed call is rejected with a clear error and never produces a WS frame.
 */
export function validateQuestionsArgs(
  args: Record<string, unknown>,
): ValidationResult {
  const rawQuestions = args.questions;
  if (!Array.isArray(rawQuestions)) {
    return { ok: false, error: "`questions` must be an array" };
  }
  if (rawQuestions.length < MIN_QUESTIONS) {
    return {
      ok: false,
      error: `\`questions\` must have at least ${MIN_QUESTIONS} entry`,
    };
  }
  if (rawQuestions.length > MAX_QUESTIONS) {
    return {
      ok: false,
      error: `\`questions\` exceeds max length ${MAX_QUESTIONS}`,
    };
  }
  const questions: QuestionSpec[] = [];
  for (let i = 0; i < rawQuestions.length; i++) {
    const q = rawQuestions[i];
    if (!q || typeof q !== "object") {
      return { ok: false, error: `questions[${i}] must be an object` };
    }
    const obj = q as Record<string, unknown>;
    const header = obj.header;
    const question = obj.question;
    const choices = obj.choices;
    if (typeof header !== "string" || header.length === 0) {
      return {
        ok: false,
        error: `questions[${i}].header must be a non-empty string`,
      };
    }
    if (header.length > MAX_HEADER_LEN) {
      return {
        ok: false,
        error: `questions[${i}].header exceeds max length ${MAX_HEADER_LEN}`,
      };
    }
    if (typeof question !== "string" || question.length === 0) {
      return {
        ok: false,
        error: `questions[${i}].question must be a non-empty string`,
      };
    }
    if (question.length > MAX_QUESTION_LEN) {
      return {
        ok: false,
        error: `questions[${i}].question exceeds max length ${MAX_QUESTION_LEN}`,
      };
    }
    if (!Array.isArray(choices)) {
      return { ok: false, error: `questions[${i}].choices must be an array` };
    }
    if (choices.length < MIN_CHOICES) {
      return {
        ok: false,
        error: `questions[${i}].choices must have at least ${MIN_CHOICES} entries`,
      };
    }
    if (choices.length > MAX_CHOICES) {
      return {
        ok: false,
        error: `questions[${i}].choices exceeds max length ${MAX_CHOICES}`,
      };
    }
    for (let j = 0; j < choices.length; j++) {
      if (typeof choices[j] !== "string") {
        return {
          ok: false,
          error: `questions[${i}].choices[${j}] must be a string`,
        };
      }
    }
    const spec: QuestionSpec = {
      header,
      question,
      choices: choices as string[],
    };
    if (typeof obj.multi_select === "boolean") {
      spec.multi_select = obj.multi_select;
    }
    if (typeof obj.allow_other === "boolean") {
      // Phase 2 deferred: kept in the type definition so mobile can light it
      // up unilaterally. No MV-time semantics on the channel side.
      spec.allow_other = obj.allow_other;
    }
    questions.push(spec);
  }
  const rawTimeout = Number(args.timeout_seconds ?? DEFAULT_TIMEOUT_S);
  const timeoutSeconds = Math.min(
    HARD_CAP_TIMEOUT_S,
    Math.max(1, Number.isFinite(rawTimeout) ? rawTimeout : DEFAULT_TIMEOUT_S),
  );
  return { ok: true, questions, timeoutSeconds };
}

export interface PresentQuestionsDeps {
  correlator: FrameCorrelator;
  broadcastFrame: (frame: Record<string, unknown>) => number;
  clientsSize: () => number;
  instanceId: string;
  generateRequestId: () => string;
  /** Test seam — overridden in unit tests to avoid touching the audit file. */
  audit?: typeof appendAudit;
  /** Test seam — overridden in unit tests to control `ts` deterministically. */
  now?: () => Date;
}

export interface PresentQuestionsResult {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  [key: string]: unknown;
}

export async function presentQuestionsToHitl(
  args: Record<string, unknown>,
  deps: PresentQuestionsDeps,
): Promise<PresentQuestionsResult> {
  const audit = deps.audit ?? appendAudit;
  const now = deps.now ?? (() => new Date());

  if (deps.clientsSize() === 0) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: "No paired HITL phone is currently connected.",
        },
      ],
    };
  }

  const v = validateQuestionsArgs(args);
  if (!v.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: v.error }],
    };
  }

  const requestId = deps.generateRequestId();
  const ts = now().toISOString();
  const frame: QuestionsBatchRequestFrame = {
    type: "questions_batch_request",
    request_id: requestId,
    questions: v.questions,
    ts,
  };

  void audit({
    ts,
    instance_id: deps.instanceId,
    direction: "cc_to_phone",
    kind: "questions_batch",
    tool_name: null,
    approval: null,
    prompt_hash: sha256Hex(JSON.stringify(v.questions)),
    duration_ms: null,
    attachment_count: 0,
    attachment_bytes: 0,
  });

  // SPEC-AW-311 — fire-and-forget dispatch (matches `present_choices_to_hitl`
  // in server.ts:383). The previous synchronous `correlator.register + await
  // waiter` pattern blocked the agent's MCP call for the full
  // `timeout_seconds` window (up to 15 min) because the phone-side response
  // never reaches the correlator: `claudeCodeService.sendMessage` POSTs to
  // `/` (notification path) and only inbound WS frames trigger
  // `correlator.resolve`. Returning immediately matches how every other
  // channel tool behaves; the user's submitted answers surface as a normal
  // channel notification on the next agent turn (carries the same
  // `request_id` so callers can correlate if they care).
  const delivered = deps.broadcastFrame(
    frame as unknown as Record<string, unknown>,
  );
  if (delivered === 0) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `present_questions_to_hitl failed: no_phone_connected_post_check (request_id=${requestId})`,
        },
      ],
    };
  }
  // `v.timeoutSeconds` is preserved on the wire frame above for the phone
  // renderer's optional UI gate; the channel no longer enforces it server-
  // side because there's no waiter to time out.
  void v.timeoutSeconds;

  return {
    content: [
      {
        type: "text" as const,
        text:
          `Survey presented to user (${v.questions.length} question${v.questions.length === 1 ? "" : "s"}, ` +
          `request_id=${requestId}). Answers will arrive as a separate ` +
          `channel notification with the same request_id.`,
      },
    ],
  };
}
