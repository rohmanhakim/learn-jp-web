// Seed importer: reads data/seed/*.json, emits an idempotent literal-value
// scripts/seed.sql, applies it with `wrangler d1 execute --file`, then
// verifies row counts (DATA-MODEL.md "Migrations & import procedure").
//
// Usage:  npm run seed           # local D1 (workerd)
//         npm run seed:remote    # production D1
//         npm run seed -- --dry-run   # write seed.sql only, don't apply

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_COUNTS,
  buildSeedStatements,
  seedHash,
  type KanjiSeedRow,
  type VocabularySeedRow,
} from "./seed-sql";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seedDir = path.join(projectRoot, "data", "seed");
const seedSqlPath = path.join(projectRoot, "scripts", "seed.sql");

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const dryRun = args.includes("--dry-run");
const target = remote ? "--remote" : "--local";
const targetName = remote ? "remote" : "local";

async function main(): Promise<void> {
  const vocabBytes = await readFile(path.join(seedDir, "vocabulary.json"));
  const kanjiBytes = await readFile(path.join(seedDir, "kanji.json"));

  const vocabularyRows: VocabularySeedRow[] = JSON.parse(vocabBytes.toString("utf8"));
  const kanjiRows: KanjiSeedRow[] = JSON.parse(kanjiBytes.toString("utf8"));

  if (vocabularyRows.length !== EXPECTED_COUNTS.vocabulary) {
    throw new Error(
      `vocabulary.json has ${vocabularyRows.length} rows, expected ${EXPECTED_COUNTS.vocabulary}`,
    );
  }
  if (kanjiRows.length !== EXPECTED_COUNTS.kanji) {
    throw new Error(`kanji.json has ${kanjiRows.length} rows, expected ${EXPECTED_COUNTS.kanji}`);
  }

  const hash = await seedHash([vocabBytes, kanjiBytes]);
  const statements = buildSeedStatements(vocabularyRows, kanjiRows, hash);
  await writeFile(seedSqlPath, `${statements.join("\n\n")}\n`, "utf8");
  console.log(`seed.sql: ${statements.length} statements, seed_hash=${hash}`);

  if (dryRun) {
    console.log("--dry-run: not applied.");
    return;
  }

  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "learn-jp", target, "--file", "scripts/seed.sql"],
    { cwd: projectRoot, stdio: "inherit" },
  );

  const result = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "learn-jp",
      target,
      "--json",
      "--command",
      "SELECT (SELECT COUNT(*) FROM vocabulary) AS vocab, (SELECT COUNT(*) FROM kanji) AS kanji, (SELECT COUNT(*) FROM vocabulary) - (SELECT COUNT(DISTINCT item_id) FROM vocabulary) AS dup_vocab, (SELECT COUNT(*) FROM kanji) - (SELECT COUNT(DISTINCT item_id) FROM kanji) AS dup_kanji",
    ],
    { cwd: projectRoot, encoding: "utf8" },
  );

  const parsed = JSON.parse(result) as {
    results?: Record<string, number>[];
  }[];
  if (!Array.isArray(parsed)) {
    throw new Error(`verification query failed: ${JSON.stringify(parsed)}`);
  }
  const rows = parsed[0]?.results?.[0];
  if (!rows) throw new Error(`unexpected verification output: ${result}`);

  const failures: string[] = [];
  if (rows.vocab !== EXPECTED_COUNTS.vocabulary) {
    failures.push(`vocabulary count ${rows.vocab} ≠ ${EXPECTED_COUNTS.vocabulary}`);
  }
  if (rows.kanji !== EXPECTED_COUNTS.kanji) {
    failures.push(`kanji count ${rows.kanji} ≠ ${EXPECTED_COUNTS.kanji}`);
  }
  if (rows.dup_vocab !== 0) failures.push(`${rows.dup_vocab} duplicate vocabulary item_id`);
  if (rows.dup_kanji !== 0) failures.push(`${rows.dup_kanji} duplicate kanji item_id`);

  if (failures.length > 0) {
    throw new Error(`seed verification failed: ${failures.join("; ")}\nraw output: ${result}`);
  }
  console.log(
    `✅ ${targetName} seeded: ${rows.vocab} vocabulary / ${rows.kanji} kanji, no duplicate item_ids`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
