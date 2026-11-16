// Pure seed-SQL generator — shared by scripts/import-seed.ts (Node CLI)
// and tests/seed.test.ts (workerd). No Node-specific imports here.
//
// Emits literal-value statements (D1 caps a statement at 100 bound
// parameters — DATA-MODEL.md) that are idempotent under re-import:
// INSERT … ON CONFLICT (item_id) DO UPDATE.

export interface VocabularySeedRow {
  item_id: string;
  content: string;
  reading?: string | null;
  meaning: string;
  level: string;
  part_of_speech?: string | null;
  source?: string | null;
}

export interface KanjiSeedRow {
  item_id: string;
  character: string;
  on_reading?: string | null;
  kun_reading?: string | null;
  meanings?: string | null;
  level: string;
  stroke_count?: number | null;
}

/** Bumped when the schema changes; written to user_config.schema_version. */
export const SCHEMA_VERSION = "1";

/** Expected seed counts (docs/DATA-MODEL.md) — verified by tests and `npm run seed`. */
export const EXPECTED_COUNTS = { vocabulary: 8334, kanji: 2091 } as const;

export const VALID_LEVELS = ["n5", "n4", "n3", "n2", "n1"] as const;

/** Rows per multi-row INSERT — keeps each statement well under D1's 100 KB cap. */
const CHUNK_SIZE = 100;

function text(value: string | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  return `'${value.replaceAll("'", "''")}'`;
}

function int(value: number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (!Number.isFinite(value)) throw new Error(`non-finite number: ${value}`);
  return String(value);
}

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    out.push(rows.slice(i, i + CHUNK_SIZE));
  }
  return out;
}

function vocabularyStatement(rows: VocabularySeedRow[]): string {
  const values = rows
    .map(
      (r) =>
        `(${text(r.item_id)}, ${text(r.content)}, ${text(r.reading)}, ${text(r.meaning)}, ${text(r.level)}, ${text(r.part_of_speech)}, ${text(r.source)})`,
    )
    .join(",\n");
  return [
    "INSERT INTO vocabulary (item_id, content, reading, meaning, level, part_of_speech, source) VALUES",
    values,
    "ON CONFLICT(item_id) DO UPDATE SET",
    "  content = excluded.content, reading = excluded.reading,",
    "  meaning = excluded.meaning, level = excluded.level,",
    "  part_of_speech = excluded.part_of_speech, source = excluded.source;",
  ].join("\n");
}

function kanjiStatement(rows: KanjiSeedRow[]): string {
  const values = rows
    .map(
      (r) =>
        `(${text(r.item_id)}, ${text(r.character)}, ${text(r.on_reading)}, ${text(r.kun_reading)}, ${text(r.meanings)}, ${text(r.level)}, ${int(r.stroke_count)})`,
    )
    .join(",\n");
  return [
    "INSERT INTO kanji (item_id, character, on_reading, kun_reading, meanings, level, stroke_count) VALUES",
    values,
    "ON CONFLICT(item_id) DO UPDATE SET",
    "  character = excluded.character, on_reading = excluded.on_reading,",
    "  kun_reading = excluded.kun_reading, meanings = excluded.meanings,",
    "  level = excluded.level, stroke_count = excluded.stroke_count;",
  ].join("\n");
}

function upsertConfig(key: string, value: string): string {
  return (
    "INSERT INTO user_config (key, value, updated_at) VALUES " +
    `(${text(key)}, ${text(value)}, datetime('now')) ` +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;"
  );
}

/**
 * SHA-256 over the seed file contents (concatenated with a separator so
 * per-file boundaries can't collide). Recorded as user_config.seed_hash
 * so content updates are detectable on re-import (DATA-MODEL.md §4).
 */
export async function seedHash(parts: Uint8Array[]): Promise<string> {
  const separator = new TextEncoder().encode("\n");
  let total = separator.length * Math.max(0, parts.length - 1);
  for (const part of parts) total += part.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part, i) => {
    if (i > 0) {
      merged.set(separator, offset);
      offset += separator.length;
    }
    merged.set(part, offset);
    offset += part.length;
  });
  const digest = await crypto.subtle.digest("SHA-256", merged);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Full set of idempotent seed statements: vocabulary, kanji, then the
 * import-tracking rows in user_config.
 */
export function buildSeedStatements(
  vocabularyRows: VocabularySeedRow[],
  kanjiRows: KanjiSeedRow[],
  hash: string,
): string[] {
  return [
    ...chunks(vocabularyRows).map(vocabularyStatement),
    ...chunks(kanjiRows).map(kanjiStatement),
    upsertConfig("schema_version", SCHEMA_VERSION),
    upsertConfig("seed_hash", hash),
  ];
}
