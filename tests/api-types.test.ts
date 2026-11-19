// P1.7 — shared API contract tests (Phase-001.md Milestone C).
//
// Acceptance for this sub-task, in three parts:
//
//  1. every documented example payload in API.md parses as valid
//     against the schema it belongs to (plus the Phase-1 additions
//     API.md gained in the same change);
//  2. `npm run typecheck` proves request/response types are checked
//     compile-time on BOTH ends (DECISIONS D11): a demo route set
//     wired exactly the way P1.8–P1.11 will wire theirs is consumed
//     through `hc<typeof demoApp>`, and the module-level type
//     assertions below turn any drift between the client's inferred
//     view and the exported contract types into a build failure;
//  3. no duplicated hand-written interfaces: the "client" here uses
//     nothing but `hc`'s inference, and the domain types (prompts.ts,
//     grader.ts, session-builder.ts) are interchangeable with the
//     wire types.
//
// The demo app deliberately lives in this test file: production routes
// arrive in P1.8–P1.11, and P1.7 must not ship stub handlers that
// would have to be deleted later. Runtime checks below drive real
// requests through it, so `zValidator`'s 400-on-invalid behavior is
// exercised too.

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { hc } from "hono/client";
import { describe, expect, it } from "vitest";
import {
  type GradingSpecWire,
  type PromptWire,
  type ResponsesRequest,
  type ResponsesResponse,
  type SessionCompleteRequest,
  type SessionCompleteResponse,
  type SessionSnapshotWire,
  type SessionStartRequest,
  type SessionStartResponse,
  type StatusResponse,
  responseItemSchema,
  promptSchema,
  responsesRequestSchema,
  responsesResponseSchema,
  sessionCompleteRequestSchema,
  sessionCompleteResponseSchema,
  sessionSnapshotSchema,
  sessionStartRequestSchema,
  sessionStartResponseSchema,
  statusResponseSchema,
} from "../src/worker/api-types";
import type { GradingSpec } from "../src/worker/grader";
import type { AppType } from "../src/worker/index";
import { type Prompt, vocabMeaningPrompt } from "../src/worker/prompts";
import type { SessionSnapshot } from "../src/worker/session-builder";

/** Exact type identity (strict) — used where the client must see the exported type, not a widened copy. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Structural assignability — used where JSON-normalizing wrappers may copy the type. */
type Extends<A, B> = A extends B ? true : false;
/** Compile-time assertion: fails `npm run typecheck` when false. */
type Expect<T extends true> = T;

/** The JSON body the hono client decodes back from a typed route. */
type ClientJson<T> = T extends Promise<infer R>
  ? R extends { json(): Promise<infer J> }
    ? J
    : never
  : never;

/**
 * Just the contract payload: `zValidator` also types its own 400
 * (a `ZodSafeParseError` body), and hono hands the client both
 * branches of that union — assertions are about the success branch.
 */
type SuccessJson<T> = Exclude<ClientJson<T>, { success: false }>;

// ─── API.md documented payloads (contract fixtures) ────────────────
// Each `: Type` annotation is a compile-time claim; the parse assertion
// that follows it in the tests below is the runtime one.

const SESSION_UUID = "6b1f2a4c-9d3e-4b7a-8c2f-1e5d9a0b3c74";
const RESPONSE_UUID = "d4c8e2b6-7a1f-4e59-9b3c-2f8a6d0e17b5";
const OTHER_RESPONSE_UUID = "a9e3f51c-2b6d-4f80-8e17-5c3b90da4e62";

/** API.md line 24. */
const statusPayload: StatusResponse = {
  streak_days: 4,
  last_session: "2026-02-10T19:22:00Z",
  due_count: 12,
  totals: { vocabulary: 8334, kanji: 2091, passages: 120 },
  weakest_bucket: "kanji",
};

/** First-run shape — no session completed yet (P1.8's empty-DB case). */
const firstRunStatusPayload: StatusResponse = {
  streak_days: 0,
  last_session: null,
  due_count: 0,
  totals: { vocabulary: 8334, kanji: 2091, passages: 0 },
  weakest_bucket: null,
};

/** API.md line 41 — the optional-hints request. */
const startRequestPayload: SessionStartRequest = {
  session_uuid: SESSION_UUID,
  max_minutes: 12,
};

/** API.md line 47 + `fast_skip_available` (P1.6 bullet, amended into API.md). */
const startResponsePayload: SessionStartResponse = {
  session_uuid: SESSION_UUID,
  title: "Session 12 · 10–15 min",
  prompts: [
    {
      prompt_key: "r:jlpt:n5:毎朝:meaning",
      kind: "recall",
      bucket: "vocab_recog",
      is_new: false,
      instruction: "Type the meaning",
      stimulus: "毎朝",
      input: "text",
      grading: { rule: "keyword", alternatives: ["every morning"] },
    },
    {
      prompt_key: "w:jlpt:n3:合図:produce",
      kind: "production",
      bucket: "writing",
      is_new: true,
      instruction: "Write a sentence using 合図",
      stimulus: "合図 (sign)",
      input: "text+selfgrade",
      grading: { rule: "production", must_contain: ["合図"] },
    },
    // Phase-3 passage prompt, exactly as API.md documents it: no
    // `is_new`, no `stimulus`, no `grading` — hence wire optionality.
    {
      prompt_key: "p:n4:park-quiet:q1",
      kind: "passage_question",
      bucket: "reading",
      passage_ref: "n4:park-quiet",
      instruction: "公園について、正しいものは？",
      choices: ["…", "…", "…"],
      input: "choice",
    },
  ],
  passages: [{ key: "n4:park-quiet", level: "n4", title: "公園の静けさ", body: "…" }],
  adaptation_note: "New items focus: kanji readings (weakest 7d: 60%)",
  fast_skip_available: false,
};

/** API.md line 98 — a graded recall response. */
const responsesRequestPayload: ResponsesRequest = {
  session_uuid: SESSION_UUID,
  responses: [
    {
      response_uuid: RESPONSE_UUID,
      prompt_key: "r:jlpt:n5:毎朝:meaning",
      item_key: "vocab:jlpt:n5:毎朝:meaning",
      bucket: "vocab_recog",
      answer: "every morning",
      self_grade: null,
      latency_ms: 4200,
    },
  ],
};

/** API.md line 159 — unknown-word capture (D-5; Phase 3 path). */
const captureRequestPayload: ResponsesRequest = {
  session_uuid: SESSION_UUID,
  responses: [
    {
      response_uuid: OTHER_RESPONSE_UUID,
      prompt_key: "capture:n4:park-quiet",
      bucket: "reading",
      answer: "アスファルト",
      kind_hint: "unknown_word",
    },
  ],
};

/** P1.15 first-run "I know this" — no typed answer, no self-grade. */
const fastSkipRequestPayload: ResponsesRequest = {
  session_uuid: SESSION_UUID,
  responses: [
    {
      response_uuid: OTHER_RESPONSE_UUID,
      prompt_key: "r:kanji:一:onkun",
      item_key: "kanji:一:onkun",
      bucket: "kanji",
      kind_hint: "fast_skip",
    },
  ],
};

/** API.md line 118 — a fresh graded result. */
const responsesResponsePayload: ResponsesResponse = {
  results: [
    {
      response_uuid: RESPONSE_UUID,
      duplicate: false,
      grade: "correct",
      srs: { due_at: "2026-02-13T00:00:00Z", interval_days: 3 },
    },
  ],
};

/** UX.md learning moment — `✗ — correct was …` needs `correct_answer`. */
const learningMomentPayload: ResponsesResponse = {
  results: [
    {
      response_uuid: RESPONSE_UUID,
      duplicate: false,
      grade: "incorrect",
      correct_answer: "every morning",
      srs: { due_at: "2026-02-10T19:22:00Z", interval_days: 0 },
    },
  ],
};

/** Production check feedback (`✓ contains 合図`) + a fractional `shaky` interval (§1). */
const productionResultPayload: ResponsesResponse = {
  results: [
    {
      response_uuid: RESPONSE_UUID,
      duplicate: false,
      grade: "shaky",
      correct_answer: "合図",
      checks: [{ value: "合図", passed: true }],
      srs: { due_at: "2026-02-13T00:00:00Z", interval_days: 3.6 },
    },
  ],
};

/** API.md line 14 — replay of a known UUID, no grading applied twice. */
const duplicateResultPayload: ResponsesResponse = {
  results: [{ response_uuid: RESPONSE_UUID, duplicate: true }],
};

/** API.md line 131 — completion request. */
const completeRequestPayload: SessionCompleteRequest = {
  session_uuid: SESSION_UUID,
  duration_sec: 640,
};

/** API.md line 138 — the full Done-screen summary (Phase 3/4 fields present). */
const completeResponsePayload: SessionCompleteResponse = {
  summary: {
    reviews: { done: 8, correct: 7 },
    new: { done: 3, correct: 2 },
    reading: {
      passage: "n4:park-quiet",
      questions: 3,
      correct: 3,
      unknown_words_captured: 2,
    },
    writing: { graded: "solid" },
    streak_days: 5,
  },
  next_session: {
    preview: "8 reviews · 3 new (kanji readings) · 1 passage",
    note: "Kanji readings are your weakest area right now.",
  },
};

/** What P1.11 actually sends in v1 — no passages, no writing bank (D-2). */
const v1CompleteResponsePayload: SessionCompleteResponse = {
  summary: {
    reviews: { done: 8, correct: 7 },
    new: { done: 3, correct: 2 },
    streak_days: 5,
  },
  next_session: {
    preview: "8 reviews · 3 new (kanji readings)",
    note: "Kanji readings are your weakest area right now.",
  },
};

// ─── 1. documented payloads parse as valid ─────────────────────────

/** Structural view of a Zod schema — lets one table hold every payload type. */
type Parseable = { safeParse(data: unknown): { success: boolean } };

const documentedPayloads: [string, Parseable, unknown][] = [
  ["GET /api/status", statusResponseSchema, statusPayload],
  ["GET /api/status (first run)", statusResponseSchema, firstRunStatusPayload],
  ["POST /api/session/start request", sessionStartRequestSchema, startRequestPayload],
  ["POST /api/session/start response", sessionStartResponseSchema, startResponsePayload],
  ["POST /api/responses request (graded)", responsesRequestSchema, responsesRequestPayload],
  ["POST /api/responses request (capture)", responsesRequestSchema, captureRequestPayload],
  ["POST /api/responses request (fast-skip)", responsesRequestSchema, fastSkipRequestPayload],
  ["POST /api/responses results", responsesResponseSchema, responsesResponsePayload],
  ["POST /api/responses results (learning moment)", responsesResponseSchema, learningMomentPayload],
  ["POST /api/responses results (production checks)", responsesResponseSchema, productionResultPayload],
  ["POST /api/responses results (duplicate)", responsesResponseSchema, duplicateResultPayload],
  ["POST /api/session/complete request", sessionCompleteRequestSchema, completeRequestPayload],
  ["POST /api/session/complete response", sessionCompleteResponseSchema, completeResponsePayload],
  ["POST /api/session/complete response (v1)", sessionCompleteResponseSchema, v1CompleteResponsePayload],
];

describe("API.md example payloads parse against their schemas", () => {
  it.each(documentedPayloads)("%s", (_name, schema, payload) => {
    const result = schema.safeParse(payload);
    expect(result.success, JSON.stringify(result, null, 2)).toBe(true);
  });
});

// ─── contract rejections ───────────────────────────────────────────

describe("the contract rejects malformed payloads", () => {
  it("rejects API.md's stale `selfgrade+text` spelling (D-9)", () => {
    const bad = structuredClone(startResponsePayload);
    const first = bad.prompts[0]!;
    (first as { input: string }).input = "selfgrade+text";
    expect(sessionStartResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown grade", () => {
    const bad = structuredClone(responsesResponsePayload);
    const first = bad.results[0]!;
    (first as { grade: string }).grade = "perfect";
    expect(responsesResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown bucket", () => {
    const bad = structuredClone(responsesRequestPayload);
    const first = bad.responses[0]!;
    (first as { bucket: string }).bucket = "grammar";
    expect(responsesRequestSchema.safeParse(bad).success).toBe(false);
  });

  it("requires a client-generated session_uuid (idempotency key)", () => {
    expect(sessionStartRequestSchema.safeParse({ max_minutes: 10 }).success).toBe(false);
    expect(
      sessionStartRequestSchema.safeParse({ session_uuid: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("requires a response_uuid on every batched item", () => {
    const bad = structuredClone(responsesRequestPayload);
    delete (bad.responses[0]! as Partial<ResponsesRequest["responses"][number]>).response_uuid;
    expect(responsesRequestSchema.safeParse(bad).success).toBe(false);
  });

  it("requires self_grade on a graded answer (P1.4's rule never fires without one)", () => {
    const bad = structuredClone(responsesRequestPayload);
    delete (bad.responses[0]! as Partial<ResponsesRequest["responses"][number]>).self_grade;
    expect(responsesRequestSchema.safeParse(bad).success).toBe(false);
  });

  it("keeps kind_hint variants disjoint — a graded answer may not carry one", () => {
    const bad = structuredClone(responsesRequestPayload);
    const first = bad.responses[0]!;
    (first as { kind_hint?: string }).kind_hint = "fast_skip";
    // fast-skip forbids self_grade, graded forbids kind_hint — either way it must fail.
    expect(responsesRequestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-UTC timestamp", () => {
    const bad = structuredClone(statusPayload);
    (bad as { last_session: string | null }).last_session = "2026-02-10T19:22:00+02:00";
    expect(statusResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("requires at least one response in a batch", () => {
    expect(responsesRequestSchema.safeParse({ session_uuid: SESSION_UUID, responses: [] }).success).toBe(false);
  });

  it("rejects a negative duration", () => {
    expect(sessionCompleteRequestSchema.safeParse({ session_uuid: SESSION_UUID, duration_sec: -1 }).success).toBe(false);
  });
});

// ─── domain ↔ wire interchangeability ──────────────────────────────

describe("domain module types satisfy the wire contract", () => {
  const factoryPrompt = vocabMeaningPrompt(
    { content: "毎朝", reading: "まいあさ", meaning: "every morning; each morning", level: "n5" },
    { isNew: true },
  );

  it("promptSchema accepts a prompt the factory emits", () => {
    expect(factoryPrompt).not.toBeNull();
    expect(promptSchema.safeParse(factoryPrompt).success).toBe(true);
  });

  it("every prompt in a builder snapshot parses (P1.9's snapshot-verbatim rule)", () => {
    const snapshot: SessionSnapshot = {
      prompts: factoryPrompt === null ? [] : [factoryPrompt],
      passages: [],
      adaptation_note: "New items focus: word meanings & readings",
      fast_skip_available: true,
    };
    expect(sessionSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
});

// ─── 2. both-ends compile-time checking (D11) ──────────────────────

// The four routes wired exactly the way P1.8–P1.11 will wire the
// production ones: `zValidator("json", <schema from api-types.ts>)` on
// the way in, a typed payload on the way out. The handlers return the
// documented payloads, so the runtime tests below drive real requests
// through real validation — no stub handlers ship in production code.
const demoApp = new Hono()
  .get("/api/status", (c) => c.json(statusPayload))
  .post("/api/session/start", zValidator("json", sessionStartRequestSchema), (c) =>
    c.json(startResponsePayload),
  )
  .post("/api/responses", zValidator("json", responsesRequestSchema), (c) =>
    c.json(responsesResponsePayload),
  )
  .post("/api/session/complete", zValidator("json", sessionCompleteRequestSchema), (c) =>
    c.json(completeResponsePayload),
  );

// The P1.12 client, in miniature: nothing but `hc`'s inference — no
// interface is written down twice anywhere.
const client = hc<typeof demoApp>("http://localhost");
const productionClient = hc<AppType>("http://localhost");

type StatusCall = ReturnType<typeof client.api.status.$get>;
type StartCall = ReturnType<typeof client.api.session.start.$post>;
type ResponsesCall = ReturnType<typeof client.api.responses.$post>;
type CompleteCall = ReturnType<typeof client.api.session.complete.$post>;
type StartRequestJson = Parameters<typeof client.api.session.start.$post>[0]["json"];
type ResponsesRequestJson = Parameters<typeof client.api.responses.$post>[0]["json"];
type CompleteRequestJson = Parameters<typeof client.api.session.complete.$post>[0]["json"];

/**
 * Compile-time assertions — `npm run typecheck` fails if the client's
 * inferred view of the contract ever diverges from the exported types,
 * or if the domain modules stop satisfying the wire shape.
 */
type TypeChecks = [
  // requests the client may send are exactly the exported request types
  Expect<Equal<StartRequestJson, SessionStartRequest>>,
  Expect<Equal<ResponsesRequestJson, ResponsesRequest>>,
  Expect<Equal<CompleteRequestJson, SessionCompleteRequest>>,
  // responses the client decodes are exactly the exported response types
  Expect<Equal<SuccessJson<StatusCall>, StatusResponse>>,
  Expect<Equal<SuccessJson<StartCall>, SessionStartResponse>>,
  Expect<Equal<SuccessJson<ResponsesCall>, ResponsesResponse>>,
  Expect<Equal<SuccessJson<CompleteCall>, SessionCompleteResponse>>,
  // domain types are interchangeable with the wire types (D-9)
  Expect<Equal<GradingSpec, GradingSpecWire>>,
  Expect<Extends<Prompt, PromptWire>>,
  Expect<Extends<SessionSnapshot, SessionSnapshotWire>>,
];

const typeChecks: TypeChecks = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];

describe("zValidator wiring — the runtime half of the contract", () => {
  const post = (payload: unknown) => ({
    method: "POST" as const,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  it("serves GET /api/status and its body satisfies the schema", async () => {
    const res = await demoApp.request("/api/status");
    expect(res.status).toBe(200);
    expect(statusResponseSchema.safeParse(await res.json()).success).toBe(true);
  });

  it("accepts the documented session/start request and returns a valid snapshot", async () => {
    const res = await demoApp.request("/api/session/start", post(startRequestPayload));
    expect(res.status).toBe(200);
    expect(sessionStartResponseSchema.safeParse(await res.json()).success).toBe(true);
  });

  it("rejects a start request without the idempotency key (400)", async () => {
    const res = await demoApp.request("/api/session/start", post({ max_minutes: 10 }));
    expect(res.status).toBe(400);
  });

  it("accepts graded, fast-skip and capture batches", async () => {
    for (const payload of [
      responsesRequestPayload,
      fastSkipRequestPayload,
      captureRequestPayload,
    ]) {
      const res = await demoApp.request("/api/responses", post(payload));
      expect(res.status, JSON.stringify(payload)).toBe(200);
    }
  });

  it("accepts each response-item variant on its own", () => {
    for (const item of [
      responsesRequestPayload.responses[0],
      fastSkipRequestPayload.responses[0],
      captureRequestPayload.responses[0],
    ]) {
      expect(responseItemSchema.safeParse(item).success, JSON.stringify(item)).toBe(true);
    }
  });

  it("rejects a batch with an unknown bucket (400)", async () => {
    const bad = structuredClone(responsesRequestPayload);
    (bad.responses[0]! as { bucket: string }).bucket = "grammar";
    const res = await demoApp.request("/api/responses", post(bad));
    expect(res.status).toBe(400);
  });

  it("accepts the completion request", async () => {
    const res = await demoApp.request("/api/session/complete", post(completeRequestPayload));
    expect(res.status).toBe(200);
    expect(sessionCompleteResponseSchema.safeParse(await res.json()).success).toBe(true);
  });

  it("both route sets are consumable by hc today", () => {
    expect(typeof client.api.session.start.$post).toBe("function");
    expect(typeof productionClient.api.status.$get).toBe("function");
  });

  it("type-level contract assertions all hold", () => {
    expect(typeChecks).toEqual(Array(typeChecks.length).fill(true));
  });
});


