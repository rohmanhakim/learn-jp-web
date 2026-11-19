// P1.10 — `POST /api/responses` acceptance tests (Phase-001.md): the
// five acceptance bullets run inside workerd against a migrated D1,
// following tests/session-start.test.ts conventions — runtime tables
// wiped at the top of every test, the production route driven via
// `app.request(path, init, env)`, and `hc<AppType>` proving the
// both-ends contract.
//
// No content seed here: nothing on this path reads `vocabulary` /
// `kanji` (unlike the builder/status tests) — grading comes from the
// snapshot, so fixtures insert one session row with a hand-built
// snapshot of four prompts (keyword / normalized_exact / production)
// and drive known answers through it. Deterministic grades, exact
// SM-2 expectations, no seed coupling.
//
// The handler owns its clock (real `Date`), so `due_at` is asserted as
// a timestamp near an expected instant (10 s tolerance), never at an
// absolute value.
import { env } from "cloudflare:workers";
import { hc } from "hono/client";
import { describe, expect, it } from "vitest";
import {
  type ApiError,
  type ResponsesRequest,
  type ResponsesResponse,
  responsesResponseSchema,
} from "../src/worker/api-types";
import app, { type AppType } from "../src/worker/index";
import { bucketAccuracies } from "../src/worker/session-builder";

// ─── fixture: one session, four served prompts ─────────────────────

const MEANING = "r:jlpt:n5:毎朝:meaning";
const MEANING_KEY = "vocab:jlpt:n5:毎朝:meaning";
const SCHOOL = "r:jlpt:n5:学校:meaning";
const SCHOOL_KEY = "vocab:jlpt:n5:学校:meaning";
const KANJI = "r:kanji:一:onkun";
const KANJI_KEY = "kanji:一:onkun";
const PRODUCE = "w:jlpt:n3:合図:produce";
const PRODUCE_KEY = "vocab:jlpt:n3:合図:produce";

const snapshot = {
  prompts: [
    {
      prompt_key: MEANING,
      kind: "recall",
      bucket: "vocab_recog",
      is_new: true,
      instruction: "Type the meaning",
      stimulus: "毎朝",
      input: "text",
      grading: { rule: "keyword", alternatives: ["every morning", "each morning"] },
    },
    {
      prompt_key: SCHOOL,
      kind: "recall",
      bucket: "vocab_recog",
      is_new: false,
      instruction: "Type the meaning",
      stimulus: "学校",
      input: "text",
      grading: { rule: "keyword", alternatives: ["school"] },
    },
    {
      prompt_key: KANJI,
      kind: "recall",
      bucket: "kanji",
      is_new: false,
      instruction: "Type a reading (on or kun)",
      stimulus: "一",
      input: "text",
      grading: { rule: "normalized_exact", alternatives: ["いち", "ひと"] },
    },
    {
      prompt_key: PRODUCE,
      kind: "production",
      bucket: "writing",
      is_new: true,
      instruction: "Write a sentence using 合図",
      stimulus: "合図 (sign)",
      input: "text+selfgrade",
      grading: { rule: "production", must_contain: ["合図"] },
    },
  ],
  passages: [],
  adaptation_note: "New items focus: word meanings & readings",
  fast_skip_available: false,
};

// ─── helpers ───────────────────────────────────────────────────────

async function resetRuntime(): Promise<void> {
  await env.DB.batch(
    ["DELETE FROM responses", "DELETE FROM sessions", "DELETE FROM srs_state"].map((sql) =>
      env.DB.prepare(sql),
    ),
  );
}

const post = (payload: unknown) => ({
  method: "POST" as const,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

/** Drive the production route; the caller asserts `status`. */
async function send(payload: unknown): Promise<{ status: number; body: unknown }> {
  const res = await app.request("/api/responses", post(payload), env);
  return { status: res.status, body: await res.json() };
}

async function insertSession(sessionUuid: string): Promise<void> {
  await env.DB
    .prepare("INSERT INTO sessions (client_uuid, started_at, snapshot) VALUES (?, ?, ?)")
    .bind(sessionUuid, new Date().toISOString(), JSON.stringify(snapshot))
    .run();
}

interface SrsRow {
  item_key: string;
  kind: string;
  ease: number;
  interval_days: number;
  due_at: string;
  reps: number;
  lapses: number;
  suspended: number;
  last_grade: string | null;
}

async function srsRow(itemKey: string): Promise<SrsRow | null> {
  return env.DB
    .prepare(
      `SELECT item_key, kind, ease, interval_days, due_at, reps, lapses, suspended, last_grade
         FROM srs_state WHERE item_key = ?`,
    )
    .bind(itemKey)
    .first<SrsRow>();
}

interface StoredResponse {
  client_uuid: string;
  item_key: string | null;
  answer: string | null;
  grade: string | null;
  bucket: string;
  kind_hint: string | null;
}

async function storedResponses(): Promise<StoredResponse[]> {
  const rows = await env.DB
    .prepare(
      "SELECT client_uuid, item_key, answer, grade, bucket, kind_hint FROM responses ORDER BY id",
    )
    .all<StoredResponse>();
  return rows.results;
}

async function responseCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM responses").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Pre-seed an `srs_state` row so a grade lands on known prior state. */
async function seedSrs(
  itemKey: string,
  kind: string,
  state: { ease: number; intervalDays: number; reps: number; lapses?: number },
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO srs_state (item_key, kind, ease, interval_days, due_at, reps, lapses, suspended)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .bind(
      itemKey,
      kind,
      state.ease,
      state.intervalDays,
      new Date(Date.now() + 86_400_000).toISOString(),
      state.reps,
      state.lapses ?? 0,
    )
    .run();
}

/** `due_at` must land near `expectedMs` (handler owns a real clock). */
function expectNear(dueIso: string, expectedMs: number): void {
  expect(Math.abs(Date.parse(dueIso) - expectedMs)).toBeLessThan(10_000);
}

const uuid = () => crypto.randomUUID();

function gradedItem(
  responseUuid: string,
  promptKey: string,
  itemKey: string,
  answer: string,
  selfGrade: "solid" | "shaky" | "wrong" | null = null,
): Record<string, unknown> {
  return {
    response_uuid: responseUuid,
    prompt_key: promptKey,
    item_key: itemKey,
    bucket: "vocab_recog",
    answer,
    self_grade: selfGrade,
    latency_ms: 4200,
  };
}

const SESSION_UUID = "11111111-2222-4333-8444-555555555555";

describe("POST /api/responses", () => {
  it("grades a mixed batch server-side and applies SM-2 to srs_state (acceptance a)", async () => {
    await resetRuntime();
    await insertSession(SESSION_UUID);
    // Known prior state per path: ease floor + lapse, first rep, shaky
    // on a 3-day interval (fractional), and a fresh correct item.
    await seedSrs(MEANING_KEY, "recall", { ease: 1.3, intervalDays: 5, reps: 3 });
    await seedSrs(PRODUCE_KEY, "production", { ease: 2.5, intervalDays: 3, reps: 2 });

    const before = Date.now();
    const { status, body } = await send({
      session_uuid: SESSION_UUID,
      responses: [
        gradedItem(uuid(), MEANING, MEANING_KEY, "zzz"), // incorrect → ease floor
        gradedItem(uuid(), SCHOOL, SCHOOL_KEY, "school"), // correct → first rep
        gradedItem(uuid(), KANJI, KANJI_KEY, "ich"), // wrong kana → incorrect
        gradedItem(uuid(), PRODUCE, PRODUCE_KEY, "これは合図です", "shaky"), // shaky
      ],
    });

    expect(status).toBe(200);
    expect(responsesResponseSchema.safeParse(body).success).toBe(true);
    const results = (body as ResponsesResponse).results;
    expect(results).toHaveLength(4);

    // incorrect on an ease-1.3 item: floor holds, reps restart, lapse counted
    expect(results[0]).toMatchObject({
      duplicate: false,
      grade: "incorrect",
      correct_answer: "every morning; each morning",
    });
    const meaning = await srsRow(MEANING_KEY);
    expect(meaning).toMatchObject({
      ease: 1.3,
      interval_days: 0,
      reps: 0,
      lapses: 1,
      last_grade: "incorrect",
    });
    expectNear(meaning!.due_at, before);
    expectNear(results[0]!.srs!.due_at, Date.parse(meaning!.due_at));

    // first correct: reps 0 → 1, interval 1, ease untouched
    expect(results[1]).toMatchObject({ duplicate: false, grade: "correct" });
    const school = await srsRow(SCHOOL_KEY);
    expect(school).toMatchObject({
      ease: 2.5,
      interval_days: 1,
      reps: 1,
      lapses: 0,
      last_grade: "correct",
      kind: "recall",
    });
    expectNear(school!.due_at, before + 86_400_000);

    // wrong reading is graded; no row existed → fresh state written
    expect(results[2]).toMatchObject({ duplicate: false, grade: "incorrect" });
    const kanji = await srsRow(KANJI_KEY);
    expect(kanji).toMatchObject({ ease: 2.3, interval_days: 0, reps: 0, lapses: 1 });

    // production: checks pass + shaky → shaky, interval 3 → 3.6 (fractional §1)
    expect(results[3]).toMatchObject({
      duplicate: false,
      grade: "shaky",
      checks: [{ value: "合図", passed: true }],
    });
    const produce = await srsRow(PRODUCE_KEY);
    expect(produce!.interval_days).toBeCloseTo(3.6, 10);
    expect(produce!.ease).toBeCloseTo(2.45, 10);
    expect(produce!.reps).toBe(2); // shaky earns no rep
    expectNear(produce!.due_at, before + Math.round(3.6 * 86_400_000));

    // every response row stored with the SERVED bucket and no kind_hint
    const rows = await storedResponses();
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.grade)).toEqual(["incorrect", "correct", "incorrect", "shaky"]);
    expect(rows[0]).toMatchObject({ bucket: "vocab_recog", kind_hint: null, item_key: MEANING_KEY });
    expect(rows[2]).toMatchObject({ bucket: "kanji", kind_hint: null });
    expect(rows[3]).toMatchObject({ bucket: "writing", answer: "これは合図です" });
  });

  it("replays a known response_uuid with duplicate:true, no re-grade, no double-count (acceptance b)", async () => {
    await resetRuntime();
    await insertSession(SESSION_UUID);
    const responseUuid = uuid();
    const payload = {
      session_uuid: SESSION_UUID,
      responses: [
        gradedItem(responseUuid, SCHOOL, SCHOOL_KEY, "school"),
        gradedItem(uuid(), MEANING, MEANING_KEY, "zzz"),
      ],
    };

    const first = await send(payload);
    expect(first.status).toBe(200);
    const firstResults = (first.body as ResponsesResponse).results;
    expect(await responseCount()).toBe(2);
    const srsBefore = await srsRow(SCHOOL_KEY);
    const srsBeforeOther = await srsRow(MEANING_KEY);

    const replay = await send(payload);
    expect(replay.status).toBe(200);
    const replayResults = (replay.body as ResponsesResponse).results;
    expect(replayResults).toHaveLength(2);

    // known UUID → duplicate with the ORIGINAL grade/display, no writes
    expect(replayResults[0]).toMatchObject({
      response_uuid: responseUuid,
      duplicate: true,
      grade: firstResults[0]!.grade,
      correct_answer: firstResults[0]!.correct_answer,
    });
    expect(await responseCount()).toBe(2); // no double-count
    expect(await srsRow(SCHOOL_KEY)).toEqual(srsBefore); // SRS not re-applied
    expect(await srsRow(MEANING_KEY)).toEqual(srsBeforeOther);
    // srs block reads the CURRENT row (decision in Phase-001.md Notes)
    expect(replayResults[0]!.srs).toEqual({
      due_at: srsBefore!.due_at,
      interval_days: srsBefore!.interval_days,
    });
    // the second item replays as duplicate too — both UUIDs are known now
    expect(replayResults[1]!.duplicate).toBe(true);
  });

  it("reports a mid-batch duplicate per item while the others land (acceptance c)", async () => {
    await resetRuntime();
    await insertSession(SESSION_UUID);
    const repeated = uuid();
    const { status, body } = await send({
      session_uuid: SESSION_UUID,
      responses: [
        gradedItem(repeated, SCHOOL, SCHOOL_KEY, "school"),
        gradedItem(uuid(), KANJI, KANJI_KEY, "いち"),
        gradedItem(repeated, SCHOOL, SCHOOL_KEY, "school"), // same UUID again
      ],
    });

    expect(status).toBe(200);
    const results = (body as ResponsesResponse).results;
    expect(results.map((r) => r.duplicate)).toEqual([false, false, true]);
    expect(results[2]).toMatchObject({ grade: "correct" }); // original result echoed
    expect(await responseCount()).toBe(2); // first + second only
  });

  it("records fast-skip as a suspended srs_state row + kind_hint response (acceptance d)", async () => {
    await resetRuntime();
    await insertSession(SESSION_UUID);
    // one skip on a fresh item, one on an item with learning history
    await seedSrs(SCHOOL_KEY, "recall", { ease: 2.5, intervalDays: 20, reps: 5 });

    const before = Date.now();
    const { status, body } = await send({
      session_uuid: SESSION_UUID,
      responses: [
        { response_uuid: uuid(), prompt_key: KANJI, item_key: KANJI_KEY, bucket: "kanji", kind_hint: "fast_skip" },
        { response_uuid: uuid(), prompt_key: SCHOOL, item_key: SCHOOL_KEY, bucket: "vocab_recog", kind_hint: "fast_skip" },
      ],
    });

    expect(status).toBe(200);
    expect(responsesResponseSchema.safeParse(body).success).toBe(true);
    const results = (body as ResponsesResponse).results;
    expect(results).toHaveLength(2);
    for (const result of results) {
      // API.md: a fast-skip result carries duplicate + srs only
      expect(result).not.toHaveProperty("grade");
      expect(result).not.toHaveProperty("correct_answer");
      expect(result).not.toHaveProperty("checks");
      expect(result.duplicate).toBe(false);
      expectNear(result.srs!.due_at, before + 30 * 86_400_000);
    }

    // fresh item → new row, suspended, due in 30 days
    const kanji = await srsRow(KANJI_KEY);
    expect(kanji).toMatchObject({
      kind: "recall",
      suspended: 1,
      ease: 2.5,
      interval_days: 0,
      reps: 0,
      lapses: 0,
      last_grade: null,
    });
    expectNear(kanji!.due_at, before + 30 * 86_400_000);
    expect(results[0]!.srs!.due_at).toBe(kanji!.due_at);

    // existing item → history preserved, only suspended + rescheduled
    const school = await srsRow(SCHOOL_KEY);
    expect(school).toMatchObject({ suspended: 1, ease: 2.5, interval_days: 20, reps: 5 });
    expectNear(school!.due_at, before + 30 * 86_400_000);

    // response rows: kind_hint set, nothing graded, bucket from the prompt
    const rows = await storedResponses();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind_hint: "fast_skip",
      answer: null,
      grade: null,
      bucket: "kanji",
      item_key: KANJI_KEY,
    });
    expect(rows[1]).toMatchObject({ kind_hint: "fast_skip", grade: null, bucket: "vocab_recog" });
  });

  it("rejects contract violations with 400 invalid_request and writes nothing (acceptance e)", async () => {
    await resetRuntime();

    // unknown session_uuid
    const unknownSession = await send({
      session_uuid: "99999999-9999-4999-8999-999999999999",
      responses: [gradedItem(uuid(), SCHOOL, SCHOOL_KEY, "school")],
    });
    expect(unknownSession.status).toBe(400);
    expect((unknownSession.body as { error: ApiError }).error.code).toBe("invalid_request");

    // prompt_key outside the stored snapshot — whole batch rejected,
    // including the valid item ahead of it (validate-before-write)
    await insertSession(SESSION_UUID);
    const foreignPrompt = await send({
      session_uuid: SESSION_UUID,
      responses: [
        gradedItem(uuid(), SCHOOL, SCHOOL_KEY, "school"),
        gradedItem(uuid(), "r:jlpt:n4:猫:meaning", "vocab:jlpt:n4:猫:meaning", "cat"),
      ],
    });
    expect(foreignPrompt.status).toBe(400);
    expect((foreignPrompt.body as { error: ApiError }).error.code).toBe("invalid_request");

    // item_key that does not match its prompt_key
    const mismatch = await send({
      session_uuid: SESSION_UUID,
      responses: [gradedItem(uuid(), MEANING, SCHOOL_KEY, "zzz")],
    });
    expect(mismatch.status).toBe(400);
    expect((mismatch.body as { error: ApiError }).error.code).toBe("invalid_request");

    // Phase-3 capture variant is contract-visible but not implemented (D-5)
    const capture = await send({
      session_uuid: SESSION_UUID,
      responses: [
        { response_uuid: uuid(), prompt_key: KANJI, bucket: "reading", answer: "アスファルト", kind_hint: "unknown_word" },
      ],
    });
    expect(capture.status).toBe(400);
    expect((capture.body as { error: ApiError }).error.code).toBe("invalid_request");

    // malformed body never reaches the payload layer (validator hook)
    const malformed = await send({ session_uuid: SESSION_UUID, responses: [{ prompt_key: SCHOOL }] });
    expect(malformed.status).toBe(400);
    expect((malformed.body as { error: ApiError }).error.code).toBe("invalid_request");

    // not one row from any of the five rejections
    expect(await responseCount()).toBe(0);
    expect(await srsRow(SCHOOL_KEY)).toBeNull();
  });

  it("keeps kind_hint rows out of bucket accuracy (D-1 / LEARNING-DESIGN §3)", async () => {
    await resetRuntime();
    await insertSession(SESSION_UUID);
    const sessionId = await env.DB
      .prepare("SELECT id FROM sessions WHERE client_uuid = ?")
      .bind(SESSION_UUID)
      .first<{ id: number }>();

    // 2 graded responses in `kanji` (1 correct → 0.5) plus a fast-skip
    // that must count in NEITHER numerator nor denominator.
    const insert = env.DB.prepare(
      `INSERT INTO responses (session_id, client_uuid, prompt_key, item_key, answer, grade, bucket, kind_hint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    await env.DB.batch([
      insert.bind(sessionId!.id, uuid(), KANJI, KANJI_KEY, "いち", "correct", "kanji", null),
      insert.bind(sessionId!.id, uuid(), KANJI, KANJI_KEY, "ちがう", "incorrect", "kanji", null),
      insert.bind(sessionId!.id, uuid(), KANJI, KANJI_KEY, null, null, "kanji", "fast_skip"),
    ]);

    const accuracies = await bucketAccuracies(env.DB, new Date());
    expect(accuracies.kanji).toBe(0.5); // 1/2 graded — not 1/3
    expect(accuracies.vocab_recog).toBeNull(); // neutral, no data
  });

  it("serves the contract through hc<AppType> against the real app (both-ends)", async () => {
    await resetRuntime();
    await insertSession(SESSION_UUID);
    const typed = hc<AppType>("http://localhost", {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => app.request(input, init, env),
    });

    const res = await typed.api.responses.$post({
      json: {
        session_uuid: SESSION_UUID,
        responses: [
          {
            response_uuid: uuid(),
            prompt_key: SCHOOL,
            item_key: SCHOOL_KEY,
            bucket: "vocab_recog",
            answer: "school",
            self_grade: null,
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    if ("error" in body) throw new Error(`unexpected error branch: ${body.error.message}`);
    expect(responsesResponseSchema.safeParse(body).success).toBe(true);
    expect(body.results[0]).toMatchObject({ duplicate: false, grade: "correct" });

    expect(typeChecks).toEqual(Array(typeChecks.length).fill(true));
    expect(typeof client.api.responses.$post).toBe("function");
    expect(typeof typed.api.responses.$post).toBe("function");
  });
});

// ─── compile-time: hc<AppType> sees exactly the contract (D11) ─────

type ClientJson<T> = T extends Promise<infer R>
  ? R extends { json(): Promise<infer J> }
    ? J
    : never
  : never;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const client = hc<AppType>("http://localhost");
type ResponsesCall = ReturnType<typeof client.api.responses.$post>;
type ResponsesRequestJson = Parameters<typeof client.api.responses.$post>[0]["json"];
/** The 200 branch plus the error envelope — nothing else. */
type SuccessJson<T> = Exclude<ClientJson<T>, { success: false }>;

/**
 * Compile-time assertions — `npm run typecheck` fails if the client's
 * inferred view of the request/response ever diverges from the exported
 * contract (D11): the request is exactly `ResponsesRequest`, the decoded
 * view is exactly the response OR the error envelope.
 */
type TypeChecks = [
  // the request the client may send is exactly the exported request type
  Expect<Equal<ResponsesRequestJson, ResponsesRequest>>,
  // the client's decoded view = the response OR the error envelope
  // (400 invalid_request from validator hook / payload module + 500)
  Expect<Equal<SuccessJson<ResponsesCall>, ResponsesResponse | { error: ApiError }>>,
];
const typeChecks: TypeChecks = [true, true];

