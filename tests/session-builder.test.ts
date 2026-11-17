// P1.6 — session builder acceptance tests (Phase-001.md): every
// acceptance bullet runs inside workerd against a seeded D1, following
// tests/seed.test.ts conventions (same seed statements `npm run seed`
// applies). Runtime fixtures are wiped at the top of each test so the
// file passes whether the plugin isolates storage per test or shares it
// across the file — content seed rows are never touched by the reset.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import kanjiRaw from "../data/seed/kanji.json?raw";
import vocabRaw from "../data/seed/vocabulary.json?raw";
import {
  buildSeedStatements,
  seedHash,
  type KanjiSeedRow,
  type VocabularySeedRow,
} from "../scripts/seed-sql";
import { itemKeyFromPromptKey } from "../src/worker/keys";
import {
  NEW_ITEM_COUNT,
  REVIEW_CAP,
  buildSession,
  dueCount,
  streakDays,
  weakestBucket,
} from "../src/worker/session-builder";

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

async function insertSession(completedAt: string | null = null): Promise<number> {
  const clientUuid = crypto.randomUUID();
  await env.DB
    .prepare(
      `INSERT INTO sessions (client_uuid, started_at, completed_at, snapshot)
       VALUES (?, ?, ?, '{}')`,
    )
    .bind(clientUuid, new Date().toISOString(), completedAt)
    .run();
  const row = await env.DB
    .prepare("SELECT id FROM sessions WHERE client_uuid = ?")
    .bind(clientUuid)
    .first<{ id: number }>();
  if (row === null) throw new Error("session insert failed");
  return row.id;
}

async function insertResponse(sessionId: number, bucket: string, grade: string): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO responses (session_id, client_uuid, prompt_key, bucket, grade)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(sessionId, `resp-${crypto.randomUUID()}`, `key-${crypto.randomUUID()}`, bucket, grade)
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

/** item_key → the prompt_key the builder must rebuild for it (P1.1 formats). */
function promptKeyForItem(itemKey: string): string {
  return itemKey.replace(/^vocab:/, "r:").replace(/^kanji:/, "r:kanji:");
}

describe("buildSession", () => {
  it("composes a first session: 3 new n5 items, fast-skip available, no passages", async () => {
    await resetRuntime();
    const snap = await buildSession(env.DB, new Date());

    expect(snap.fast_skip_available).toBe(true);
    expect(snap.passages).toEqual([]);
    expect(snap.prompts).toHaveLength(NEW_ITEM_COUNT);
    expect(snap.prompts.every((p) => p.is_new)).toBe(true);

    // vocab_recog kind mix: direction alternates meaning → reading → meaning
    const keys = snap.prompts.map((p) => p.prompt_key);
    expect(keys.map((k) => k.endsWith(":meaning"))).toEqual([true, false, true]);
    // level heuristic: lowest level (n5) still has unseen items
    expect(keys.every((k) => k.includes(":jlpt:n5:"))).toBe(true);
    // three distinct words
    expect(new Set(keys.map((k) => k.split(":")[3])).size).toBe(NEW_ITEM_COUNT);
    // neutral handling: no graded history ⇒ weakest is null, note says so
    expect(snap.adaptation_note).toBe(
      "New items focus: word meanings & readings — no history yet, starting from the basics",
    );
    // snapshot is plain JSON (sessions.snapshot round-trip)
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    // builder ↔ /api/responses identity agreement: every key maps to an item_key
    for (const key of keys) expect(itemKeyFromPromptKey(key)).not.toBeNull();
  });

  it("caps reviews at 25, oldest-due first, excluding suspended and future rows", async () => {
    await resetRuntime();
    const now = Date.now();
    const base = now - 60 * 60 * 1000; // all due an hour ago, one second apart
    const rows = await env.DB
      .prepare("SELECT item_id FROM vocabulary WHERE level = 'n1' ORDER BY id LIMIT 32")
      .all<{ item_id: string }>();
    const itemIds: string[] = rows.results.map((r) => r.item_id);
    const itemId = (i: number): string => {
      const id = itemIds[i];
      if (id === undefined) throw new Error(`fixture row ${i} missing`);
      return id;
    };

    const dueKeys: string[] = [];
    for (let i = 0; i < 30; i++) {
      const key = `vocab:${itemId(i)}:meaning`;
      dueKeys.push(key);
      await insertDueRow(key, new Date(base + i * 1000).toISOString());
    }
    const suspendedKey = `vocab:${itemId(30)}:meaning`;
    await insertDueRow(suspendedKey, new Date(base - 86_400_000).toISOString(), 1);
    const futureKey = `vocab:${itemId(31)}:meaning`;
    await insertDueRow(futureKey, new Date(now + 3_600_000).toISOString());

    const snap = await buildSession(env.DB, new Date());
    // due_count shares the builder's filter but is uncapped (§4 cap is composition)
    expect(await dueCount(env.DB, new Date())).toBe(30);

    const reviews = snap.prompts.slice(0, REVIEW_CAP);
    const newItems = snap.prompts.slice(REVIEW_CAP);
    expect(snap.prompts).toHaveLength(REVIEW_CAP + NEW_ITEM_COUNT);
    // exact oldest-due order; the 5 overflow rows roll to the next session
    expect(reviews.map((p) => p.prompt_key)).toEqual(
      dueKeys.slice(0, REVIEW_CAP).map(promptKeyForItem),
    );
    expect(reviews.every((p) => !p.is_new)).toBe(true);
    expect(newItems.every((p) => p.is_new)).toBe(true);
    const reviewKeys = reviews.map((p) => p.prompt_key);
    expect(reviewKeys).not.toContain(promptKeyForItem(suspendedKey));
    expect(reviewKeys).not.toContain(promptKeyForItem(futureKey));
  });

  it("draws new items from the weakest bucket and reports the actual draw", async () => {
    await resetRuntime();
    const sessionId = await insertSession();
    for (let i = 0; i < 4; i++) await insertResponse(sessionId, "vocab_recog", "correct");
    await insertResponse(sessionId, "kanji", "correct");
    await insertResponse(sessionId, "kanji", "incorrect"); // kanji 50% < vocab 100%; rest neutral

    const snap = await buildSession(env.DB, new Date());
    expect(snap.fast_skip_available).toBe(false); // sessions table non-empty
    expect(snap.prompts).toHaveLength(NEW_ITEM_COUNT);
    expect(snap.prompts.every((p) => p.bucket === "kanji")).toBe(true);
    expect(snap.prompts.every((p) => p.prompt_key.startsWith("r:kanji:"))).toBe(true);
    expect(snap.prompts.every((p) => p.is_new)).toBe(true);
    // draws are distinct even though the query is random
    expect(new Set(snap.prompts.map((p) => p.prompt_key)).size).toBe(NEW_ITEM_COUNT);
    expect(snap.adaptation_note).toBe("New items focus: kanji readings (weakest 7d: 50%)");
  });

  it("falls back to an actionable bucket when reading is weakest (no passages in v1)", async () => {
    await resetRuntime();
    const sessionId = await insertSession();
    await insertResponse(sessionId, "reading", "incorrect"); // reading 0%
    for (let i = 0; i < 10; i++) {
      await insertResponse(sessionId, "vocab_recog", "correct");
      await insertResponse(sessionId, "kanji", "correct");
      await insertResponse(sessionId, "writing", "correct");
    }

    const snap = await buildSession(env.DB, new Date());
    expect(snap.passages).toEqual([]);
    expect(snap.prompts).toHaveLength(NEW_ITEM_COUNT);
    expect(snap.prompts.some((p) => p.kind === "passage_question")).toBe(false);
    // fallback order starts at vocab_recog after the never-actionable reading bucket
    expect(snap.prompts.every((p) => p.bucket === "vocab_recog")).toBe(true);
    expect(snap.adaptation_note).toBe(
      "New items focus: word meanings & readings (reading is weakest, passages arrive later)",
    );
  });

  it("treats neutral buckets as neutral, not weakest (lone data bucket wins)", async () => {
    await resetRuntime();
    const sessionId = await insertSession();
    for (let i = 0; i < 5; i++) await insertResponse(sessionId, "kanji", "correct");

    const snap = await buildSession(env.DB, new Date());
    // If neutral (no-data) buckets counted as weakest, the draw would have
    // fallen through to vocab_recog instead of serving the data bucket.
    expect(snap.prompts.every((p) => p.bucket === "kanji")).toBe(true);
    expect(snap.adaptation_note).toBe("New items focus: kanji readings (weakest 7d: 100%)");
  });

  it("never returns zero prompts even when every bank item is seen and suspended", async () => {
    await resetRuntime();
    // One statement per direction: mark the entire bank as fast-skipped
    // (suspended + long overdue) so no reviews and no unseen items remain.
    await env.DB.batch(
      [
        `INSERT INTO srs_state (item_key, kind, due_at, suspended)
         SELECT 'vocab:' || item_id || ':meaning', 'recall', '2000-01-01T00:00:00.000Z', 1
         FROM vocabulary`,
        `INSERT INTO srs_state (item_key, kind, due_at, suspended)
         SELECT 'vocab:' || item_id || ':reading', 'recall', '2000-01-01T00:00:00.000Z', 1
         FROM vocabulary`,
        `INSERT INTO srs_state (item_key, kind, due_at, suspended)
         SELECT 'vocab:' || item_id || ':produce', 'recall', '2000-01-01T00:00:00.000Z', 1
         FROM vocabulary`,
        `INSERT INTO srs_state (item_key, kind, due_at, suspended)
         SELECT item_id || ':onkun', 'recall', '2000-01-01T00:00:00.000Z', 1
         FROM kanji`,
      ].map((sql) => env.DB.prepare(sql)),
    );

    const snap = await buildSession(env.DB, new Date());
    expect(snap.prompts.length).toBeGreaterThan(0); // D3: never a dead end
    // safety net: SRS ignored, the bank still serves NEW_ITEM_COUNT prompts
    expect(snap.prompts).toHaveLength(NEW_ITEM_COUNT);
    expect(snap.prompts.every((p) => p.is_new)).toBe(true);
  });
});

describe("streakDays", () => {
  it("is 0 with no completed sessions (first run)", async () => {
    await resetRuntime();
    expect(await streakDays(env.DB, new Date())).toBe(0);
  });

  it("counts consecutive UTC days back from today", async () => {
    await resetRuntime();
    const now = new Date();
    await insertSession(now.toISOString());
    await insertSession(new Date(now.getTime() - 86_400_000).toISOString());
    expect(await streakDays(env.DB, now)).toBe(2);
  });

  it("is 0 when the latest session predates yesterday (streak broken)", async () => {
    await resetRuntime();
    await insertSession(new Date(Date.now() - 3 * 86_400_000).toISOString());
    expect(await streakDays(env.DB, new Date())).toBe(0);
  });
});

describe("weakestBucket", () => {
  it("ignores neutral buckets and breaks ties by BUCKETS declaration order", () => {
    expect(
      weakestBucket({ vocab_recog: 0.5, kanji: 0.5, reading: null, writing: null }),
    ).toBe("vocab_recog");
    expect(
      weakestBucket({ vocab_recog: 1, kanji: 0.4, reading: 0.9, writing: null }),
    ).toBe("kanji");
    expect(
      weakestBucket({ vocab_recog: null, kanji: null, reading: null, writing: null }),
    ).toBeNull();
  });
});


