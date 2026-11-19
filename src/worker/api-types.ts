// P1.7 — shared API contract (Phase-001.md Milestone C): every request
// and response of API.md written down exactly once, as Zod schemas that
// serve BOTH as the runtime validator (attached to routes with
// @hono/zod-validator in P1.8–P1.11) and as the compile-time type the
// PWA consumes through `hc<AppType>` (DECISIONS D11). There is
// deliberately no parallel hand-written interface file: the schema *is*
// the type, so server and client cannot drift.
//
// Enums are DERIVED from the module that owns them, never re-spelled
// (D-9): grades/buckets/self-grades/prompt kinds from keys.ts, the
// `input` spelling from prompts.ts's PROMPT_INPUTS, and the grading
// rules mirror grader.ts's GradingSpec one-for-one (tests assert the
// two types are interchangeable in both directions). Widening a domain
// enum widens this contract automatically.
//
// Forward compatibility — API.md documents fields v1 never serves, and
// they are accepted here so Phase 3 needs no contract change:
// `input: "choice"`, `kind: "passage_question"`, `passage_ref`,
// `choices`, `summary.reading`, `summary.writing`, and the
// `unknown_word` capture variant of a response item. On a prompt,
// `is_new`, `stimulus` and `grading` are optional *on the wire only*
// because API.md's passage example omits them (a passage question is
// graded by answer_index, not a grading spec); every prompt v1 serves
// carries all three — tests/api-types.test.ts pins that prompts.ts's
// `Prompt` is assignable to this shape.
//
// Response items are told apart by `kind_hint`: a graded answer must
// NOT carry one (the literal `z.undefined()` rejects the string), the
// first-run fast-skip (P1.15) and the unknown-word capture (D-5)
// must. The `srs` block is fractional-day safe (`shaky` produces
// e.g. 3.6, LEARNING-DESIGN §1) and is optional, as are `grade` /
// `correct_answer` / `checks` — capture and replay-only results carry
// none.
//
// Errors follow API.md line 5 — {"error": {code, message}} — defined
// here so the client has one error type; P1.8+ routes return it.

import { z } from "zod";
import { BUCKETS, GRADES, PROMPT_KINDS, SELF_GRADES } from "./keys";
import { PROMPT_INPUTS } from "./prompts";

// ─── primitives ────────────────────────────────────────────────────

/** UTC ISO-8601 (`2026-02-10T19:22:00Z`) — API.md line 4: all times UTC. */
export const isoDateTimeSchema = z.iso.datetime();

/** Client-generated idempotency key (API.md idempotency rules). */
export const uuidSchema = z.uuid();

/** API.md line 5 error envelope. */
export const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof errorSchema>;

/** Non-negative whole count (totals, due_count, summary counts). */
const countSchema = z.number().int().nonnegative();

// ─── session snapshot (API.md session/start) ───────────────────────

/**
 * The stored grading spec a prompt carries (API.md `grading`), as a
 * wire schema — the same three rules grader.ts accepts, so a snapshot
 * round-trips into `gradeAnswer` without a conversion layer (P1.10).
 */
export const gradingSchema = z.discriminatedUnion("rule", [
  z.object({ rule: z.literal("keyword"), alternatives: z.array(z.string()) }),
  z.object({ rule: z.literal("normalized_exact"), alternatives: z.array(z.string()) }),
  z.object({ rule: z.literal("production"), must_contain: z.array(z.string()) }),
]);
export type GradingSpecWire = z.infer<typeof gradingSchema>;

/** One prompt exactly as served (API.md `prompts[]`). */
export const promptSchema = z.object({
  prompt_key: z.string().min(1),
  kind: z.enum(PROMPT_KINDS),
  bucket: z.enum(BUCKETS),
  /** Absent on API.md's passage prompt; every v1 prompt sends it. */
  is_new: z.boolean().optional(),
  instruction: z.string(),
  /** Absent on API.md's passage prompt (the passage body is the cue). */
  stimulus: z.string().optional(),
  input: z.enum(PROMPT_INPUTS),
  /** Absent on API.md's passage prompt (graded by answer_index, §2). */
  grading: gradingSchema.optional(),
  /** Phase 3 only — the passage this question belongs to. */
  passage_ref: z.string().optional(),
  /** Phase 3 only — the `choice` control's options. */
  choices: z.array(z.string()).optional(),
});
export type PromptWire = z.infer<typeof promptSchema>;

/** One passage body, self-contained for offline (API.md `passages[]`). */
export const passageSchema = z.object({
  key: z.string().min(1),
  /** Plain string while passages are always [] in v1 (D-2); Phase 3 narrows to LEVELS. */
  level: z.string(),
  title: z.string().nullable(),
  body: z.string(),
});
export type PassageWire = z.infer<typeof passageSchema>;

/**
 * What `sessions.snapshot` stores (DATA-MODEL) — the `session/start`
 * response minus its transport fields (P1.6's `SessionSnapshot`).
 */
export const sessionSnapshotSchema = z.object({
  prompts: z.array(promptSchema),
  passages: z.array(passageSchema),
  /** One human sentence: what was focused on and why (§4 rule 4). */
  adaptation_note: z.string(),
  /** Drives the first-run "I know this" action (P1.15). */
  fast_skip_available: z.boolean(),
});
export type SessionSnapshotWire = z.infer<typeof sessionSnapshotSchema>;

// ─── GET /api/status ───────────────────────────────────────────────

export const statusResponseSchema = z.object({
  streak_days: countSchema,
  /** `null` on a first run — no session has completed yet. */
  last_session: isoDateTimeSchema.nullable(),
  due_count: countSchema,
  totals: z.object({
    vocabulary: countSchema,
    kanji: countSchema,
    passages: countSchema,
  }),
  weakest_bucket: z.enum(BUCKETS).nullable(),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

// ─── POST /api/session/start ───────────────────────────────────────

export const sessionStartRequestSchema = z.object({
  /** Required: the client-generated idempotency key (API.md line 10). */
  session_uuid: uuidSchema,
  /** Optional composition hint — the server may ignore it (API.md line 39). */
  max_minutes: z.number().int().positive().optional(),
});
export type SessionStartRequest = z.infer<typeof sessionStartRequestSchema>;

export const sessionStartResponseSchema = z.object({
  session_uuid: uuidSchema,
  title: z.string(),
  ...sessionSnapshotSchema.shape,
});
export type SessionStartResponse = z.infer<typeof sessionStartResponseSchema>;

// ─── POST /api/responses (batch) ───────────────────────────────────

const responseItemShape = {
  response_uuid: uuidSchema,
  prompt_key: z.string().min(1),
  bucket: z.enum(BUCKETS),
  latency_ms: z.number().int().nonnegative().optional(),
};

/** API.md line 100 — a graded answer. No `kind_hint`, ever. */
const gradedResponseSchema = z.object({
  ...responseItemShape,
  item_key: z.string().min(1),
  answer: z.string(),
  /** Required (nullable) so production prompts always carry a verdict. */
  self_grade: z.enum(SELF_GRADES).nullable(),
  kind_hint: z.undefined().optional(),
});

/** P1.15 first-run "I know this": no typed answer, no self-grade. */
const fastSkipResponseSchema = z.object({
  ...responseItemShape,
  item_key: z.string().min(1),
  kind_hint: z.literal("fast_skip"),
  answer: z.string().optional(),
  self_grade: z.undefined().optional(),
});

/** API.md line 159 — unknown-word capture (D-5); no SRS identity yet. */
const captureResponseSchema = z.object({
  ...responseItemShape,
  kind_hint: z.literal("unknown_word"),
  answer: z.string(),
  item_key: z.undefined().optional(),
  self_grade: z.undefined().optional(),
});

/** One entry of the `responses[]` batch. */
export const responseItemSchema = z.union([
  gradedResponseSchema,
  fastSkipResponseSchema,
  captureResponseSchema,
]);
export type ResponseItem = z.infer<typeof responseItemSchema>;

export const responsesRequestSchema = z.object({
  session_uuid: uuidSchema,
  responses: z.array(responseItemSchema).min(1),
});
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

/** Next scheduling state for a graded item (API.md line 119). */
export const srsResultSchema = z.object({
  due_at: isoDateTimeSchema,
  /** REAL — the `shaky` path produces fractions (§1). */
  interval_days: z.number().nonnegative(),
});

/**
 * One per-item result. Partial success is the rule (API.md line 14):
 * every entry echoes its `response_uuid` and reports `duplicate` when
 * the UUID was already known; `grade` / `correct_answer` / `checks` /
 * `srs` appear when there was something to report — the inline
 * learning moment (`✗ — correct was …`, UX.md) reads `correct_answer`
 * and `checks` off this.
 */
export const responseResultSchema = z.object({
  response_uuid: uuidSchema,
  duplicate: z.boolean(),
  grade: z.enum(GRADES).optional(),
  correct_answer: z.string().optional(),
  checks: z.array(z.object({ value: z.string(), passed: z.boolean() })).optional(),
  srs: srsResultSchema.optional(),
});
export type ResponseResult = z.infer<typeof responseResultSchema>;

export const responsesResponseSchema = z.object({
  results: z.array(responseResultSchema),
});
export type ResponsesResponse = z.infer<typeof responsesResponseSchema>;

// ─── POST /api/session/complete ────────────────────────────────────

export const sessionCompleteRequestSchema = z.object({
  session_uuid: uuidSchema,
  duration_sec: z.number().int().nonnegative(),
});
export type SessionCompleteRequest = z.infer<typeof sessionCompleteRequestSchema>;

/** Done-screen counts (API.md line 139). */
export const summarySchema = z.object({
  reviews: z.object({ done: countSchema, correct: countSchema }),
  new: z.object({ done: countSchema, correct: countSchema }),
  /** Phase 3 only — never sent in v1 (no passages). */
  reading: z
    .object({
      passage: z.string(),
      questions: countSchema,
      correct: countSchema,
      unknown_words_captured: countSchema,
    })
    .optional(),
  /** Phase 4 only — never sent in v1 (no writing bank). */
  writing: z.object({ graded: z.enum(SELF_GRADES) }).optional(),
  streak_days: countSchema,
});
export type SessionSummary = z.infer<typeof summarySchema>;

export const nextSessionSchema = z.object({
  preview: z.string(),
  note: z.string(),
});
export type NextSession = z.infer<typeof nextSessionSchema>;

export const sessionCompleteResponseSchema = z.object({
  summary: summarySchema,
  next_session: nextSessionSchema,
});
export type SessionCompleteResponse = z.infer<typeof sessionCompleteResponseSchema>;
