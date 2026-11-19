// P1.9 — `POST /api/session/start` acceptance tests (Phase-001.md): the
// three acceptance bullets run inside workerd against a seeded D1, following
// tests/status.test.ts conventions — content seed once in `beforeAll`,
// runtime tables wiped at the top of every test (so the file passes whether
// the plugin isolates storage per test or shares it across the file; content
// seed rows are never touched by the reset), the production route driven via
// `app.request(path, init, env)`, and `hc<AppType>` proving the both-ends
// contract.
//
// The handler owns its clock (real `Date`), so `started_at` is only asserted
// as a fresh UTC ISO-8601 timestamp — never at an absolute value.
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
  type SessionStartRequest,
  type SessionStartResponse,
  sessionSnapshotSchema,
  sessionStartResponseSchema,
} from "../src/worker/api-types";
import app, { type AppType } from "../src/worker/index";

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

/** Drive the production route; the caller asserts `status`. */
async function start(payload: unknown): Promise<{ status: number; body: unknown }> {
  const res = await app.request("/api/session/start", post(payload), env);
  return { status: res.status, body: await res.json() };
}

async function startUuid(sessionUuid: string): Promise<SessionStartResponse> {
  const { status, body } = await start({ session_uuid: sessionUuid });
  expect(status).toBe(200);
  expect(sessionStartResponseSchema.safeParse(body).success).toBe(true);
  return body as SessionStartResponse;
}

interface StoredSession {
  client_uuid: string;
  started_at: string;
  snapshot: string;
}

async function storedSessions(): Promise<StoredSession[]> {
  const rows = await env.DB
    .prepare("SELECT client_uuid, started_at, snapshot FROM sessions ORDER BY id")
    .all<StoredSession>();
  return rows.results;
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
type StartCall = ReturnType<typeof client.api.session.start.$post>;
type StartRequestJson = Parameters<typeof client.api.session.start.$post>[0]["json"];

type TypeChecks = [
  // the request the client may send is exactly the exported request type
  Expect<Equal<StartRequestJson, SessionStartRequest>>,
  // the client's decoded start view = the response OR the error envelope
  // (400 invalid_request from the validator hook + 500 internal_error)
  Expect<Equal<SuccessJson<StartCall>, SessionStartResponse | { error: ApiError }>>,
];

const typeChecks: TypeChecks = [true, true];

describe("POST /api/session/start", () => {
  it("persists the snapshot verbatim on a fresh start (acceptance a)", async () => {
    await resetRuntime();
    const sessionUuid = crypto.randomUUID();
    const body = await startUuid(sessionUuid);

    const rows = await storedSessions();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.client_uuid).toBe(sessionUuid);
    expect(row.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // the stored snapshot IS the served snapshot minus its transport fields
    expect(JSON.parse(row.snapshot)).toEqual({
      prompts: body.prompts,
      passages: body.passages,
      adaptation_note: body.adaptation_note,
      fast_skip_available: body.fast_skip_available,
    });
    expect(sessionSnapshotSchema.safeParse(JSON.parse(row.snapshot)).success).toBe(true);

    expect(body.title).toBe("Session 1 · 10–15 min");
    // first run — no sessions row existed when the builder ran
    expect(body.fast_skip_available).toBe(true);
    expect(body.passages).toEqual([]); // D-2: v1 serves no passages
    expect(body.prompts.length).toBeGreaterThan(0); // D3: never a dead end
    expect(body.adaptation_note.length).toBeGreaterThan(0);
  });

  it("replays the same session_uuid to the identical body with no second row (acceptance b)", async () => {
    await resetRuntime();
    const sessionUuid = crypto.randomUUID();
    const first = await startUuid(sessionUuid);
    const replay = await startUuid(sessionUuid);

    expect(replay).toEqual(first);
    expect(await storedSessions()).toHaveLength(1);
  });

  it("numbers sessions by row ordinal, stable across later starts and replays", async () => {
    await resetRuntime();
    const firstUuid = crypto.randomUUID();
    const first = await startUuid(firstUuid);
    const second = await startUuid(crypto.randomUUID());

    expect(first.title).toBe("Session 1 · 10–15 min");
    expect(second.title).toBe("Session 2 · 10–15 min");

    // a replay after later starts answers the very same body (N included)
    expect(await startUuid(firstUuid)).toEqual(first);
    expect(await storedSessions()).toHaveLength(2);
  });

  it("counts abandoned (never completed) sessions toward the number", async () => {
    await resetRuntime();
    await startUuid(crypto.randomUUID());
    // second session even though the first was never completed
    const second = await startUuid(crypto.randomUUID());
    expect(second.title).toBe("Session 2 · 10–15 min");
  });

  it("rejects a body without the idempotency key (400, API.md envelope)", async () => {
    await resetRuntime();
    const { status, body } = await start({ max_minutes: 10 });
    expect(status).toBe(400);
    const err = body as { error: ApiError };
    expect(err.error.code).toBe("invalid_request");
    expect(err.error.message.length).toBeGreaterThan(0);
    expect(await storedSessions()).toHaveLength(0); // nothing persisted
  });

  it("rejects a non-UUID session_uuid (400, API.md envelope)", async () => {
    await resetRuntime();
    const { status, body } = await start({ session_uuid: "not-a-uuid" });
    expect(status).toBe(400);
    expect((body as { error: ApiError }).error.code).toBe("invalid_request");
    expect(await storedSessions()).toHaveLength(0);
  });

  it("serves the contract through hc<AppType> against the real app (both-ends)", async () => {
    await resetRuntime();
    const typed = hc<AppType>("http://localhost", {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => app.request(input, init, env),
    });
    const res = await typed.api.session.start.$post({
      json: { session_uuid: crypto.randomUUID() },
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    if ("error" in body) throw new Error(`unexpected error branch: ${body.error.message}`);
    expect(sessionStartResponseSchema.safeParse(body).success).toBe(true);
    expect(body.prompts.length).toBeGreaterThan(0);
    expect(body.title).toBe("Session 1 · 10–15 min");
  });

  it("keeps the compile-time client assertions true", () => {
    expect(typeChecks).toEqual(Array(typeChecks.length).fill(true));
    expect(typeof client.api.session.start.$post).toBe("function");
  });
});

