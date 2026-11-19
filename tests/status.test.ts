// P1.8 — `GET /api/status` acceptance tests (Phase-001.md): every
// acceptance bullet runs inside workerd against a seeded D1, following
// tests/seed.test.ts / tests/session-builder.test.ts conventions (same
// seed statements `npm run seed` applies; runtime fixtures wiped at the
// top of each test so the file passes whether the plugin isolates
// storage per test or shares it across the file — content seed rows are
// never touched by the reset).
//
// The handler injects its own `now` (real clock), so fixtures are built
// relative to `Date.now()` — never at absolute timestamps — and every
// assertion that can be pinned to a shared helper is compared against
// that helper's output (single implementation, not a second copy).
import { env } from "cloudflare:workers";
import { hc } from "hono/client";
import { beforeAll, describe, expect, it } from "vitest";
import kanjiRaw from "../data/seed/kanji.json?raw";
import vocabRaw from "../data/seed/vocabulary.json?raw";
import {
  EXPECTED_COUNTS,
  buildSeedStatements,
  seedHash,
  type KanjiSeedRow,
  type VocabularySeedRow,
} from "../scripts/seed-sql";
import {
  type ApiError,
  type StatusResponse,
  statusResponseSchema,
} from "../src/worker/api-types";
import app, { type AppType } from "../src/worker/index";
import { bucketAccuracies, dueCount, weakestBucket } from "../src/worker/session-builder";

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

async function insertSession(completedAt: string | null): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO sessions (client_uuid, started_at, completed_at, snapshot)
       VALUES (?, ?, ?, '{}')`,
    )
    .bind(crypto.randomUUID(), new Date().toISOString(), completedAt)
    .run();
}

async function insertResponse(sessionId: number, bucket: string, grade: string): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO responses (session_id, client_uuid, prompt_key, bucket, grade)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(sessionId, crypto.randomUUID(), `key-${crypto.randomUUID()}`, bucket, grade)
    .run();
}

async function insertDueRow(itemKey: string, dueAt: string, suspended = 0): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO srs_state (item_key, kind, due_at, suspended)
       VALUES (?, 'recall', ?, ?)`,
    )
    .bind(itemKey, dueAt, suspended)
    .run();
}
async function lastSessionId(): Promise<number> {
  const row = await env.DB
    .prepare("SELECT id FROM sessions ORDER BY id DESC LIMIT 1")
    .first<{ id: number }>();
  if (row === null) throw new Error("session insert failed");
  return row.id;
}

/** ISO timestamp `days` days before now (D-3's UTC calendar-day basis). */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Drive the production route with the real bindings; parse-check the body. */
async function fetchStatus(): Promise<StatusResponse> {
  const res = await app.request("/api/status", undefined, env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as StatusResponse;
  expect(statusResponseSchema.safeParse(body).success).toBe(true);
  return body;
}

// ─── compile-time: hc<AppType> sees exactly the contract (D11) ─────

type ClientJson<T> = T extends Promise<infer R>
  ? R extends { json(): Promise<infer J> }
    ? J
    : never
  : never;
/** The 200 branch and the errorSchema 500 branch — nothing else. */
type SuccessJson<T> = Exclude<ClientJson<T>, { success: false }>;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const client = hc<AppType>("http://localhost");
type StatusCall = ReturnType<typeof client.api.status.$get>;

type TypeChecks = [
  // the client's decoded status view = StatusResponse | the error envelope
  Expect<Equal<SuccessJson<StatusCall>, StatusResponse | { error: ApiError }>>,
];

const typeChecks: TypeChecks = [true];
describe("GET /api/status", () => {
  it("serves the API.md first-run shape on an empty DB", async () => {
    await resetRuntime();
    const status = await fetchStatus();
    expect(status).toEqual({
      streak_days: 0,
      last_session: null,
      due_count: 0,
      totals: {
        vocabulary: EXPECTED_COUNTS.vocabulary,
        kanji: EXPECTED_COUNTS.kanji,
        passages: 0, // D-2: v1 serves no passages
      },
      weakest_bucket: null,
    });
  });

  it("counts a single session; abandoned sessions never show as last activity", async () => {
    await resetRuntime();
    await insertSession(null); // started, never completed (DATA-MODEL retention)
    const completedAt = daysAgo(0);
    await insertSession(completedAt);

    const status = await fetchStatus();
    expect(status.streak_days).toBe(1);
    expect(status.last_session).toBe(completedAt);
    expect(status.weakest_bucket).toBe(null);
  });

  it("counts consecutive UTC days and stops at a gap (D-3)", async () => {
    await resetRuntime();
    await insertSession(daysAgo(0));
    await insertSession(daysAgo(1));
    await insertSession(daysAgo(2));
    expect((await fetchStatus()).streak_days).toBe(3);

    // Gap-only history: a run that already ended days ago never counts.
    await resetRuntime();
    await insertSession(daysAgo(2));
    await insertSession(daysAgo(3));
    expect((await fetchStatus()).streak_days).toBe(0);
  });

  it("keeps yesterday's session in the streak until the UTC day rolls over", async () => {
    await resetRuntime();
    await insertSession(daysAgo(1));
    expect((await fetchStatus()).streak_days).toBe(1);
  });

  it("reports due_count through the builder's shared query (suspended/future excluded)", async () => {
    await resetRuntime();
    const rows = await env.DB
      .prepare("SELECT item_id FROM vocabulary WHERE level = 'n5' ORDER BY id LIMIT 5")
      .all<{ item_id: string }>();
    const ids = rows.results.map((r) => r.item_id);
    const itemId = (i: number): string => {
      const id = ids[i];
      if (id === undefined) throw new Error(`fixture row ${i} missing`);
      return id;
    };

    await insertDueRow(`vocab:${itemId(0)}:meaning`, daysAgo(1));
    await insertDueRow(`vocab:${itemId(1)}:meaning`, daysAgo(1));
    await insertDueRow(`vocab:${itemId(2)}:meaning`, new Date(Date.now() - 60_000).toISOString());
    await insertDueRow(`vocab:${itemId(3)}:meaning`, daysAgo(2), 1); // suspended ⇒ never due
    await insertDueRow(`vocab:${itemId(4)}:meaning`, new Date(Date.now() + 3_600_000).toISOString());

    const status = await fetchStatus();
    expect(status.due_count).toBe(3);
    expect(status.due_count).toBe(await dueCount(env.DB, new Date()));
  });

  it("reports weakest_bucket through the builder's shared accuracy helpers", async () => {
    await resetRuntime();
    await insertSession(daysAgo(0));
    const sessionId = await lastSessionId();
    for (let i = 0; i < 4; i++) await insertResponse(sessionId, "vocab_recog", "correct");
    await insertResponse(sessionId, "kanji", "correct");
    await insertResponse(sessionId, "kanji", "incorrect"); // kanji 50% < vocab 100%; rest neutral

    const status = await fetchStatus();
    expect(status.weakest_bucket).toBe("kanji");
    expect(status.weakest_bucket).toBe(weakestBucket(await bucketAccuracies(env.DB, new Date())));
    expect(status.due_count).toBe(0); // untouched by response rows
  });

  it("serves the contract through hc<AppType> against the real app (both-ends)", async () => {
    await resetRuntime();
    const typed = hc<AppType>("http://localhost", {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
        app.request(input, init, env),
    });
    const res = await typed.api.status.$get();
    expect(res.ok).toBe(true);
    const body = await res.json();
    if ("error" in body) throw new Error(`unexpected error branch: ${body.error.message}`);
    expect(statusResponseSchema.safeParse(body).success).toBe(true);
    expect(body.totals.vocabulary).toBe(EXPECTED_COUNTS.vocabulary);
  });

  it("keeps the compile-time client assertions true", () => {
    expect(typeChecks).toEqual(Array(typeChecks.length).fill(true));
    expect(typeof client.api.status.$get).toBe("function");
  });
});