// Import unit tests (TASKS.md Phase 0): counts, uniqueness of item_id,
// and valid level tags — verified against a real D1 database running in
// workerd, seeded by the same statements `npm run seed` applies.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import kanjiRaw from "../data/seed/kanji.json?raw";
import vocabRaw from "../data/seed/vocabulary.json?raw";
import {
  EXPECTED_COUNTS,
  VALID_LEVELS,
  buildSeedStatements,
  seedHash,
  type KanjiSeedRow,
  type VocabularySeedRow,
} from "../scripts/seed-sql";

const vocabularyRows: VocabularySeedRow[] = JSON.parse(vocabRaw);
const kanjiRows: KanjiSeedRow[] = JSON.parse(kanjiRaw);
const hash = await seedHash([
  new TextEncoder().encode(vocabRaw),
  new TextEncoder().encode(kanjiRaw),
]);

// Same statements the CLI applies; run twice to prove idempotency.
const statements = buildSeedStatements(vocabularyRows, kanjiRows, hash);

beforeAll(async () => {
  // Apply twice: proves the ON CONFLICT upserts are idempotent.
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
});

async function scalar(query: string): Promise<number> {
  const row = await env.DB.prepare(query).first<Record<string, number>>();
  const value = row === null ? undefined : Object.values(row)[0];
  return typeof value === "number" ? value : Number.NaN;
}

describe("seed files", () => {
  it("matches documented row counts", () => {
    expect(vocabularyRows.length).toBe(EXPECTED_COUNTS.vocabulary);
    expect(kanjiRows.length).toBe(EXPECTED_COUNTS.kanji);
  });

  it("has unique item_ids in the source JSON", () => {
    expect(new Set(vocabularyRows.map((r) => r.item_id)).size).toBe(vocabularyRows.length);
    expect(new Set(kanjiRows.map((r) => r.item_id)).size).toBe(kanjiRows.length);
  });

  it("has valid level tags in the source JSON", () => {
    const valid = new Set<string>(VALID_LEVELS);
    expect(vocabularyRows.filter((r) => !valid.has(r.level)).length).toBe(0);
    expect(kanjiRows.filter((r) => !valid.has(r.level)).length).toBe(0);
  });
});

describe("import into D1", () => {
  it("loads all rows with the documented counts", async () => {
    expect(await scalar("SELECT COUNT(*) FROM vocabulary")).toBe(EXPECTED_COUNTS.vocabulary);
    expect(await scalar("SELECT COUNT(*) FROM kanji")).toBe(EXPECTED_COUNTS.kanji);
  });

  it("keeps item_id unique in the database", async () => {
    expect(
      await scalar(
        "SELECT COUNT(*) - COUNT(DISTINCT item_id) FROM vocabulary",
      ),
    ).toBe(0);
    expect(await scalar("SELECT COUNT(*) - COUNT(DISTINCT item_id) FROM kanji")).toBe(0);
  });

  it("stores only valid level tags in the database", async () => {
    const inList = VALID_LEVELS.map((l) => `'${l}'`).join(",");
    expect(await scalar(`SELECT COUNT(*) FROM vocabulary WHERE level NOT IN (${inList})`)).toBe(
      0,
    );
    expect(await scalar(`SELECT COUNT(*) FROM kanji WHERE level NOT IN (${inList})`)).toBe(0);
  });

  it("records schema_version and seed_hash in user_config", async () => {
    const schemaVersion = await env.DB.prepare(
      "SELECT value FROM user_config WHERE key = 'schema_version'",
    ).first<{ value: string }>();
    const seedHashValue = await env.DB.prepare(
      "SELECT value FROM user_config WHERE key = 'seed_hash'",
    ).first<{ value: string }>();
    expect(schemaVersion?.value).toBe("1");
    expect(seedHashValue?.value).toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
