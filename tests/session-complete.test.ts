// P1.11 — `POST /api/session/complete` acceptance tests (Phase-001.md):
// the three acceptance bullets run inside workerd against a seeded D1,
// following tests/session-start.test.ts conventions — content seed once
// in `beforeAll` (the preview projection re-runs the builder, so it needs
// real content rows), runtime tables wiped at the top of every test, the
// production routes driven via `app.request(path, init, env)`, and
// `hc<AppType>` proving the both-ends contract.
//
// The sharp bullet is (b): the served `next_session.preview` is checked
// against a REAL follow-up `session/start` in the same post-session DB
// state (API.md: "must match, not approximate"). Handlers own their clock
// (real `Date`), so timestamps are only asserted as fresh UTC ISO-8601.
import { env } from "cloudflare:workers";
import { hc } from "hono/client";
import { beforeAll, describe, expect, it } from "vitest";
import kanjiRaw from "../data/seed/kanji.json?raw";
import vocabRaw from "../data/seed/vocabulary.json?raw";
import {
  buildSeedStatements,
  seedHash,
  type KanjiSeedRow,
  type VocabularySeedRow,
} from "../scripts/seed-sql";
import {
  type ApiError,
  type SessionCompleteRequest,
  type SessionCompleteResponse,
  type SessionStartResponse,
  sessionCompleteResponseSchema,
  sessionStartResponseSchema,
} from "../src/worker/api-types";
import app, { type AppType } from "../src/worker/index";
import { bucketLabel } from "../src/worker/session-builder";

const vocabularyRows: VocabularySeedRow[] = JSON.parse(vocabRaw);
const kanjiRows: KanjiSeedRow[] = JSON.parse(kanjiRaw);
const hash = await seedHash([
  new TextEncoder().encode(vocabRaw),
  new TextEncoder().encode(kanjiRaw),
]);
const statements = buildSeedStatements(vocabularyRows, kanjiRows, hash);

beforeAll(async () => {
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
});

/** Wipe runtime tables only — the content seed survives every test. */
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

/** Drive a production route; the caller asserts `status`. */
async function call(path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path, post(payload), env);
  return { status: res.status, body: await res.json() };
}

async function startUuid(sessionUuid: string): Promise<SessionStartResponse> {
  const { status, body } = await call("/api/session/start", { session_uuid: sessionUuid });
  expect(status).toBe(200);
  expect(sessionStartResponseSchema.safeParse(body).success).toBe(true);
  return body as SessionStartResponse;
}

async function completeUuid(
  sessionUuid: string,
  durationSec = 640,
): Promise<SessionCompleteResponse> {
  const { status, body } = await call("/api/session/complete", {
    session_uuid: sessionUuid,
    duration_sec: durationSec,
  });
  expect(status).toBe(200);
  expect(sessionCompleteResponseSchema.safeParse(body).success).toBe(true);
  return body as SessionCompleteResponse;
}

/** Reviews vs new, exactly how the summary splits them (`is_new`). */
function split(body: SessionStartResponse) {
  return {
    reviews: body.prompts.filter((prompt) => prompt.is_new !== true),
    fresh: body.prompts.filter((prompt) => prompt.is_new === true),
  };
}

async function sessionIdOf(sessionUuid: string): Promise<number> {
  const row = await env.DB
    .prepare("SELECT id FROM sessions WHERE client_uuid = ?")
    .bind(sessionUuid)
    .first<{ id: number }>();
  if (row === null) throw new Error(`session row missing for ${sessionUuid}`);
  return row.id;
}

interface StoredCompletion {
  completed_at: string | null;
  duration_sec: number | null;
  stats: string | null;
}

async function storedCompletion(sessionUuid: string): Promise<StoredCompletion> {
  const row = await env.DB
    .prepare("SELECT completed_at, duration_sec, stats FROM sessions WHERE client_uuid = ?")
    .bind(sessionUuid)
    .first<StoredCompletion>();
  if (row === null) throw new Error(`session row missing for ${sessionUuid}`);
  return row;
}

/** `count` due (an hour ago) vocab-meaning SRS rows → the next start serves them as reviews. */
async function insertDueReviews(count: number): Promise<void> {
  const rows = await env.DB
    .prepare("SELECT item_id FROM vocabulary WHERE level = 'n1' ORDER BY id LIMIT ?")
    .bind(count)
    .all<{ item_id: string }>();
  const dueAt = new Date(Date.now() - 3_600_000).toISOString();
  for (const row of rows.results) {
    await env.DB
      .prepare(
        "INSERT INTO srs_state (item_key, kind, due_at, suspended) VALUES (?, 'recall', ?, 0)",
      )
      .bind(`vocab:${row.item_id}:meaning`, dueAt)
      .run();
  }
}

/** A response row with a KNOWN grade — summary math stays exact (P1.10 fixture style). */
async function insertResponse(
  sessionId: number,
  prompt: { prompt_key: string; bucket: string },
  grade: string | null,
  kindHint: string | null = null,
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO responses (session_id, client_uuid, prompt_key, bucket, grade, kind_hint)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(sessionId, crypto.randomUUID(), prompt.prompt_key, prompt.bucket, grade, kindHint)
    .run();
}


// ─── compile-time: hc<AppType> sees exactly the contract (D11) ─────

type ClientJson<T> = T extends Promise<infer R>
  ? R extends { json(): Promise<infer J> }
    ? J
    : never
  : never;
/** The 200 branch plus the error envelope — nothing else. */
type SuccessJson<T> = Exclude<ClientJson<T>, { success: false }>;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const client = hc<AppType>("http://localhost");
type CompleteCall = ReturnType<typeof client.api.session.complete.$post>;
type CompleteRequestJson = Parameters<typeof client.api.session.complete.$post>[0]["json"];

type TypeChecks = [
  // the request the client may send is exactly the exported request type
  Expect<Equal<CompleteRequestJson, SessionCompleteRequest>>,
  // the client's decoded view = the response OR the error envelope
  // (400 invalid_request from the validator hook + 500 internal_error)
  Expect<Equal<SuccessJson<CompleteCall>, SessionCompleteResponse | { error: ApiError }>>,
];

const typeChecks: TypeChecks = [true, true];

describe("POST /api/session/complete", () => {
  it("finalizes the row and derives the summary from known responses (acceptance a)", async () => {
    await resetRuntime();
    await insertDueReviews(2);
    const sessionUuid = crypto.randomUUID();
    const started = await startUuid(sessionUuid);
    const { reviews, fresh } = split(started);
    expect(reviews).toHaveLength(2);
    expect(fresh).toHaveLength(3);
    const sessionId = await sessionIdOf(sessionUuid);

    await insertResponse(sessionId, reviews[0]!, "correct");
    await insertResponse(sessionId, reviews[1]!, "incorrect");
    await insertResponse(sessionId, fresh[0]!, "correct");
    await insertResponse(sessionId, fresh[1]!, "shaky");
    // D-1 fast-skip: counted as done, never correct, never in accuracy
    await insertResponse(sessionId, fresh[2]!, null, "fast_skip");

    const body = await completeUuid(sessionUuid, 640);
    expect(body.summary).toEqual({
      reviews: { done: 2, correct: 1 },
      new: { done: 3, correct: 1 },
      streak_days: 1,
    });

    const row = await storedCompletion(sessionUuid);
    expect(row.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row.duration_sec).toBe(640);
    // DATA-MODEL "Session stats": 4 graded rows — correct, incorrect,
    // correct, shaky → 2/4 = 0.5 (the fast-skip is excluded, §3)
    expect(JSON.parse(row.stats ?? "null")).toEqual({
      counts: { reviews: 2, new: 3 },
      accuracy: { vocab_recog: 0.5 },
      buckets_practiced: ["vocab_recog"],
    });

    // hybrid note: the measured weakest bucket IS the projected draw
    expect(body.next_session.note).toBe(
      "Word meanings & readings are your weakest area right now.",
    );
    expect(body.next_session.preview).toContain("2 reviews");
    expect(body.next_session.preview).toContain("3 new");
  });

  it("falls back to the projection's adaptation_note when no history exists", async () => {
    await resetRuntime();
    const sessionUuid = crypto.randomUUID();
    await startUuid(sessionUuid);
    const body = await completeUuid(sessionUuid);

    expect(body.summary.reviews).toEqual({ done: 0, correct: 0 });
    expect(body.summary.new).toEqual({ done: 0, correct: 0 });
    expect(body.summary.streak_days).toBe(1);
    expect(body.next_session.note).toBe(
      "New items focus: word meanings & readings — no history yet, starting from the basics",
    );
    expect(body.next_session.preview).toContain("3 new");
  });

  it("serves a preview that matches the real next session/start (acceptance b)", async () => {
    await resetRuntime();
    await insertDueReviews(2);
    const sessionUuid = crypto.randomUUID();
    const started = await startUuid(sessionUuid);
    const { reviews, fresh } = split(started);
    const sessionId = await sessionIdOf(sessionUuid);
    await insertResponse(sessionId, reviews[0]!, "correct");
    await insertResponse(sessionId, fresh[0]!, "incorrect");

    const body = await completeUuid(sessionUuid);

    // The very next start, same post-session DB state: its real
    // composition is what the preview must have promised.
    const next = await startUuid(crypto.randomUUID());
    const nextSplit = split(next);
    const reviewMatch = body.next_session.preview.match(/(\d+) reviews?/);
    const newMatch = body.next_session.preview.match(/(\d+) new(?: \(([^)]+)\))?/);
    expect(Number(reviewMatch?.[1] ?? 0)).toBe(nextSplit.reviews.length);
    expect(Number(newMatch?.[1])).toBe(nextSplit.fresh.length);
    const drawn = new Set(nextSplit.fresh.map((prompt) => prompt.bucket));
    if (drawn.size === 1) expect(newMatch?.[2]).toBe(bucketLabel([...drawn][0]!));
  });

  it("is idempotent: a replay writes nothing and inflates no stat (acceptance c)", async () => {
    await resetRuntime();
    await insertDueReviews(2);
    const sessionUuid = crypto.randomUUID();
    await startUuid(sessionUuid);
    const first = await completeUuid(sessionUuid, 640);
    const stored = await storedCompletion(sessionUuid);

    const replay = await completeUuid(sessionUuid, 999); // a different duration must not stick
    expect(replay).toEqual(first);
    expect(await storedCompletion(sessionUuid)).toEqual(stored);
    const counts = await env.DB
      .prepare(
        `SELECT (SELECT COUNT(*) FROM sessions)  AS sessions,
                (SELECT COUNT(*) FROM responses) AS responses`,
      )
      .first<{ sessions: number; responses: number }>();
    expect(counts).toEqual({ sessions: 1, responses: 0 });
  });

  it("counts a prior-day completion toward the streak (D-3)", async () => {
    await resetRuntime();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    await env.DB
      .prepare(
        `INSERT INTO sessions (client_uuid, started_at, completed_at, snapshot)
         VALUES (?, ?, ?, '{}')`,
      )
      .bind(crypto.randomUUID(), yesterday, yesterday)
      .run();

    const sessionUuid = crypto.randomUUID();
    await startUuid(sessionUuid);
    const body = await completeUuid(sessionUuid);
    expect(body.summary.streak_days).toBe(2); // yesterday + today
  });

  it("rejects an unknown session_uuid (400, API.md envelope)", async () => {
    await resetRuntime();
    const { status, body } = await call("/api/session/complete", {
      session_uuid: crypto.randomUUID(),
      duration_sec: 640,
    });
    expect(status).toBe(400);
    expect((body as { error: ApiError }).error.code).toBe("invalid_request");
  });

  it("rejects a body without duration_sec (400) and leaves the session uncompleted", async () => {
    await resetRuntime();
    const sessionUuid = crypto.randomUUID();
    await startUuid(sessionUuid);
    const { status, body } = await call("/api/session/complete", { session_uuid: sessionUuid });
    expect(status).toBe(400);
    expect((body as { error: ApiError }).error.code).toBe("invalid_request");
    const row = await storedCompletion(sessionUuid);
    expect(row.completed_at).toBeNull();
    expect(row.duration_sec).toBeNull();
    expect(row.stats).toBeNull();
  });

  it("serves the contract through hc<AppType> against the real app (both-ends)", async () => {
    await resetRuntime();
    const typed = hc<AppType>("http://localhost", {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => app.request(input, init, env),
    });
    const started = await typed.api.session.start.$post({
      json: { session_uuid: crypto.randomUUID() },
    });
    expect(started.ok).toBe(true);
    const startedBody = await started.json();
    if ("error" in startedBody) {
      throw new Error(`unexpected error branch: ${startedBody.error.message}`);
    }
    expect(sessionStartResponseSchema.safeParse(startedBody).success).toBe(true);

    const res = await typed.api.session.complete.$post({
      json: { session_uuid: startedBody.session_uuid, duration_sec: 640 },
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    if ("error" in body) throw new Error(`unexpected error branch: ${body.error.message}`);
    expect(sessionCompleteResponseSchema.safeParse(body).success).toBe(true);
    expect(body.summary.streak_days).toBe(1);
    expect(body.next_session.preview.length).toBeGreaterThan(0);
    expect(body.next_session.note.length).toBeGreaterThan(0);
  });

  it("keeps the compile-time client assertions true", () => {
    expect(typeChecks).toEqual(Array(typeChecks.length).fill(true));
    expect(typeof client.api.session.complete.$post).toBe("function");
  });
});
