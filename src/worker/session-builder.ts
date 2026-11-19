// P1.6 — session builder v1 (Phase-001.md Milestone B): decides what one
// session serves — due reviews, then 3 new items drawn from the weakest
// bucket — and emits the snapshot JSON persisted in `sessions.snapshot`
// (API.md `POST /api/session/start` body, minus the transport fields
// P1.9 adds on top).
//
// Owns the shared queries that /api/status reuses (Phase-001.md Notes:
// single implementation, never a second copy): `dueCount`,
// `bucketAccuracies`/`weakestBucket`, `streakDays` — P1.8 imports them.
//
// DB access: raw `D1Database` SQL (repo precedent — index.ts and the
// seed tooling; the Drizzle schema documents the DDL but no runtime
// query builder is in use yet). `now` is a parameter (srs.ts convention)
// so every test is deterministic; `due_at` values are UTC ISO-8601
// (P1.2 always sets them explicitly), so lexicographic `due_at <= ?`
// comparisons are correct. `created_at` comes from SQLite's
// `datetime('now')` default, so the rolling-window comparison formats
// its bound the same way ("YYYY-MM-DD HH:MM:SS").
//
// v1 scope (D-2): recall + vocab production only — §4 rule 3 (content
// piece) is skipped, so `passages` is always [] and a weakest `reading`
// bucket falls through to the next actionable bucket; a
// `passage_question` is never served. Accuracy follows §3: correct /
// total graded responses over the last 7 days, a bucket with no data is
// neutral and never weakest. The query excludes D-1's `kind_hint`
// rows (`AND kind_hint IS NULL`): a fast-skip is recorded but never
// counts as a graded response (LEARNING-DESIGN §3).

import {
  BUCKETS,
  LEVELS,
  type Bucket,
  type ItemKey,
  type RecallDirection,
  type VocabDirection,
  isBucket,
  parseItemKey,
} from "./keys";
import {
  type KanjiRowLike,
  type Prompt,
  type VocabRowLike,
  kanjiReadingPrompt,
  vocabMeaningPrompt,
  vocabProductionPrompt,
  vocabReadingPrompt,
} from "./prompts";

/** Reviews per session (§4 rule 1): overflow rolls to the next session. */
export const REVIEW_CAP = 25;

/** New items per session (§4 rule 2, default 3). */
export const NEW_ITEM_COUNT = 3;

const MS_PER_DAY = 86_400_000;
const ROLLING_WINDOW_DAYS = 7;

/**
 * Buckets that can contribute new items in v1, in fallback order after
 * the weakest bucket. `reading` is absent: its new items would be the
 * content piece (§4 rule 3), skipped in v1 (D-2), so when `reading` is
 * weakest the draw falls through this list instead.
 */
const ACTIONABLE_BUCKETS = ["vocab_recog", "kanji", "writing"] as const;

const BUCKET_LABELS: Record<Bucket, string> = {
  vocab_recog: "word meanings & readings",
  kanji: "kanji readings",
  reading: "reading comprehension",
  writing: "sentence production",
};

/** One passage as it would appear in the snapshot (API.md `passages`). */
export interface PassageSnapshot {
  key: string;
  level: string;
  title: string | null;
  body: string;
}

/** What `sessions.snapshot` stores — API.md `session/start` minus transport fields. */
export interface SessionSnapshot {
  prompts: Prompt[];
  /** Self-contained offline bodies; always [] in v1 (D-2, no content piece). */
  passages: PassageSnapshot[];
  /** One human sentence: what was focused on and why (§4 rule 4). */
  adaptation_note: string;
  /** True until the first `sessions` row exists — drives "I know this" (P1.15). */
  fast_skip_available: boolean;
}

/** Rolling 7-day accuracy per bucket; `null` = no graded data (neutral, §3). */
export type BucketAccuracies = { [K in Bucket]: number | null };

/**
 * Compose the next session. Reviews come first (oldest-due order), then
 * new items; never returns an empty prompt list (D3 — the seeded banks
 * guarantee unseen items, with an ignore-SRS safety net below).
 */
export async function buildSession(db: D1Database, now: Date): Promise<SessionSnapshot> {
  const nowIso = now.toISOString();
  const reviews = await reviewPrompts(db, nowIso);
  const accuracies = await bucketAccuracies(db, now);
  const weakest = weakestBucket(accuracies);
  const draw = await drawNewItems(db, weakest);

  const sessions = await db
    .prepare("SELECT COUNT(*) AS n FROM sessions")
    .first<{ n: number }>();

  return {
    prompts: [...reviews, ...draw.prompts],
    passages: [],
    adaptation_note: adaptationNote(draw.bucket, accuracies, weakest),
    fast_skip_available: (sessions?.n ?? 0) === 0,
  };
}

/**
 * How many items are due right now — the same filter the builder's
 * review query uses (P1.8's `due_count`); uncapped, because the §4 cap
 * is a composition rule, not a change in what is due.
 */
export async function dueCount(db: D1Database, now: Date): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM srs_state
        WHERE due_at <= ? AND suspended = 0`,
    )
    .bind(now.toISOString())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Rolling 7-day accuracy per bucket (§3): `correct / total graded`
 * responses in the window; buckets with no rows stay `null` (neutral).
 * `kind_hint` rows (D-1 fast-skip) are excluded — a skip is not a
 * graded response.
 */
export async function bucketAccuracies(db: D1Database, now: Date): Promise<BucketAccuracies> {
  const since = sqliteDateTime(new Date(now.getTime() - ROLLING_WINDOW_DAYS * MS_PER_DAY));
  const result = await db
    .prepare(
      `SELECT bucket,
              SUM(CASE WHEN grade = 'correct' THEN 1 ELSE 0 END) AS correct,
              COUNT(*) AS total
         FROM responses
        WHERE created_at >= ? AND kind_hint IS NULL
        GROUP BY bucket`,
    )
    .bind(since)
    .all<{ bucket: string; correct: number | null; total: number }>();

  const accuracies = Object.fromEntries(BUCKETS.map((b) => [b, null])) as BucketAccuracies;
  for (const row of result.results) {
    if (!isBucket(row.bucket) || row.total === 0) continue;
    accuracies[row.bucket] = (row.correct ?? 0) / row.total;
  }
  return accuracies;
}

/**
 * The weakest bucket by 7-day accuracy (§3): lowest accuracy among
 * buckets with data; neutral buckets are skipped, ties break on `BUCKETS`
 * declaration order so the result is deterministic. `null` when every
 * bucket is neutral (first run).
 */
export function weakestBucket(accuracies: BucketAccuracies): Bucket | null {
  let weakest: Bucket | null = null;
  let worst = Number.POSITIVE_INFINITY;
  for (const bucket of BUCKETS) {
    const accuracy = accuracies[bucket];
    if (accuracy === null) continue; // neutral, never weakest (§3)
    if (accuracy < worst) {
      worst = accuracy;
      weakest = bucket;
    }
  }
  return weakest;
}

/**
 * Consecutive UTC calendar days (D-3) with a `completed_at` session,
 * counted back from today; yesterday's session still counts until the
 * UTC day rolls over. `0` when the latest session predates yesterday.
 * Shared with P1.8's `streak_days`.
 */
export async function streakDays(db: D1Database, now: Date): Promise<number> {
  const result = await db
    .prepare(
      `SELECT DISTINCT substr(completed_at, 1, 10) AS day
         FROM sessions
        WHERE completed_at IS NOT NULL
        ORDER BY day DESC`,
    )
    .all<{ day: string }>();

  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - MS_PER_DAY).toISOString().slice(0, 10);
  let expected: string | null = null;
  let count = 0;
  for (const row of result.results) {
    if (row.day > today) continue; // clock-skew guard: never extends the run
    if (expected === null) {
      if (row.day !== today && row.day !== yesterday) break; // streak already broken
      expected = row.day;
    }
    if (row.day !== expected) break;
    count += 1;
    expected = previousUtcDay(expected);
  }
  return count;
}

// ─── reviews (§4 rule 1) ─────────────────────────────────────────────

/** Rebuild prompts for the oldest-due SRS rows, capped at `REVIEW_CAP`. */
async function reviewPrompts(db: D1Database, nowIso: string): Promise<Prompt[]> {
  const due = await db
    .prepare(
      `SELECT item_key
         FROM srs_state
        WHERE due_at <= ? AND suspended = 0
        ORDER BY due_at ASC
        LIMIT ?`,
    )
    .bind(nowIso, REVIEW_CAP)
    .all<{ item_key: string }>();

  const entries: ItemKey[] = [];
  const vocabIds = new Set<string>();
  const kanjiIds = new Set<string>();
  for (const row of due.results) {
    const parsed = parseItemKey(row.item_key);
    if (parsed === null) continue; // unparseable key: skip, never crash a session
    entries.push(parsed);
    if (parsed.kind === "vocab") vocabIds.add(`jlpt:${parsed.level}:${parsed.surface}`);
    if (parsed.kind === "kanji") kanjiIds.add(`kanji:${parsed.character}`);
    // passage/writing keys cannot appear in v1 SRS state (D-2); ignored.
  }

  const vocabRows = await fetchVocabRows(db, vocabIds);
  const kanjiRows = await fetchKanjiRows(db, kanjiIds);

  const prompts: Prompt[] = [];
  for (const parsed of entries) {
    const prompt = promptFromItem(parsed, vocabRows, kanjiRows);
    // null = content-driven skip (P1.5's null-tolerance, e.g. 2 seed rows
    // with no reading): the row simply rolls to the next session.
    if (prompt !== null) prompts.push(prompt);
  }
  return prompts;
}

function promptFromItem(
  parsed: ItemKey,
  vocabRows: Map<string, VocabRowLike>,
  kanjiRows: Map<string, KanjiRowLike>,
): Prompt | null {
  switch (parsed.kind) {
    case "vocab": {
      const row = vocabRows.get(`jlpt:${parsed.level}:${parsed.surface}`);
      if (row === undefined) return null; // content row gone (seed drift): skip
      const options = { isNew: false };
      switch (parsed.direction) {
        case "meaning":
          return vocabMeaningPrompt(row, options);
        case "reading":
          return vocabReadingPrompt(row, options);
        case "produce":
          return vocabProductionPrompt(row, options);
      }
      break;
    }
    case "kanji": {
      const row = kanjiRows.get(`kanji:${parsed.character}`);
      if (row === undefined) return null;
      return kanjiReadingPrompt(row, { isNew: false });
    }
    case "passage":
    case "writing":
      return null; // not SRS-scheduled in v1 (D-2)
  }
  return null;
}

async function fetchVocabRows(
  db: D1Database,
  itemIds: ReadonlySet<string>,
): Promise<Map<string, VocabRowLike>> {
  const ids = [...itemIds];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT item_id, content, reading, meaning, level
         FROM vocabulary
        WHERE item_id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{ item_id: string } & VocabRowLike>();
  return new Map(result.results.map((row) => [row.item_id, row]));
}

async function fetchKanjiRows(
  db: D1Database,
  itemIds: ReadonlySet<string>,
): Promise<Map<string, KanjiRowLike>> {
  const ids = [...itemIds];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT item_id, character, on_reading AS "onReading", kun_reading AS "kunReading"
         FROM kanji
        WHERE item_id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{ item_id: string } & KanjiRowLike>();
  return new Map(result.results.map((row) => [row.item_id, row]));
}

// ─── new items (§4 rule 2) ───────────────────────────────────────────

interface NewDraw {
  prompts: Prompt[];
  /** The bucket that contributed the first new prompts; null only if nothing was drawn. */
  bucket: Bucket | null;
}

/**
 * Draw `NEW_ITEM_COUNT` new items: weakest bucket first, then the v1
 * fallback order, each bucket tried down to `LEVELS`' last level
 * ("lowest level where new items remain"). Never serves a
 * `passage_question` — a weakest `reading` bucket yields nothing and
 * falls through (acceptance bullet).
 */
async function drawNewItems(db: D1Database, weakest: Bucket | null): Promise<NewDraw> {
  const prompts: Prompt[] = [];
  const usedSurfaces = new Set<string>();
  const usedKanji = new Set<string>();
  let actual: Bucket | null = null;

  for (const bucket of bucketDrawOrder(weakest)) {
    while (prompts.length < NEW_ITEM_COUNT) {
      const drawn = await drawBucket(
        db,
        bucket,
        NEW_ITEM_COUNT - prompts.length,
        prompts.length,
        usedSurfaces,
        usedKanji,
      );
      if (drawn.length === 0) break; // bucket exhausted (or never actionable in v1)
      if (actual === null) actual = bucket;
      prompts.push(...drawn);
    }
    if (prompts.length >= NEW_ITEM_COUNT) break;
  }

  if (prompts.length === 0) {
    // D3 safety net: unreachable with a seeded bank — it requires every
    // item seen AND suspended — but a dead end is never an option, so
    // serve vocabulary ignoring SRS state rather than zero prompts.
    prompts.push(...(await drawRegardlessOfSrs(db)));
  }

  return { prompts, bucket: actual };
}

/** Weakest bucket first, then the actionable fallback order. */
function bucketDrawOrder(weakest: Bucket | null): Bucket[] {
  const order: Bucket[] = [];
  if (weakest !== null) order.push(weakest);
  for (const bucket of ACTIONABLE_BUCKETS) {
    if (bucket !== weakest) order.push(bucket);
  }
  return order;
}

/**
 * Up to `count` prompts of one bucket, continuing the direction
 * alternation from `startIndex` so a topped-up draw stays M,R,M,…
 * Returns [] when the bucket is exhausted at every level (or is
 * `reading`, whose new items are the skipped content piece).
 */
async function drawBucket(
  db: D1Database,
  bucket: Bucket,
  count: number,
  startIndex: number,
  usedSurfaces: Set<string>,
  usedKanji: Set<string>,
): Promise<Prompt[]> {
  if (bucket === "reading") return []; // content piece skipped in v1 (§4 rule 3)
  const prompts: Prompt[] = [];
  while (prompts.length < count) {
    const slot = startIndex + prompts.length;
    const prompt =
      bucket === "kanji"
        ? await drawOneKanji(db, usedKanji)
        : bucket === "writing"
          ? await drawOneProduction(db, usedSurfaces)
          : await drawOneRecall(db, slot, usedSurfaces);
    if (prompt === null) break; // exhausted — let the next bucket try
    prompts.push(prompt);
  }
  return prompts;
}

/**
 * `vocab_recog` new item: direction alternates meaning → reading →
 * meaning by slot (the bucket's "kind mix"). If the slot's direction is
 * exhausted the other one is tried before giving up on the bucket.
 */
async function drawOneRecall(
  db: D1Database,
  slot: number,
  usedSurfaces: Set<string>,
): Promise<Prompt | null> {
  let direction: RecallDirection = slot % 2 === 0 ? "meaning" : "reading";
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await drawVocabRow(db, direction, usedSurfaces);
    if (row === null) {
      direction = direction === "meaning" ? "reading" : "meaning";
      continue;
    }
    const prompt =
      direction === "meaning"
        ? vocabMeaningPrompt(row, { isNew: true })
        : vocabReadingPrompt(row, { isNew: true });
    if (prompt !== null) return prompt;
    // Content-driven null (P1.5): the row is already excluded via
    // usedSurfaces, so the next attempt makes progress with a new word.
  }
  return null;
}

async function drawOneProduction(
  db: D1Database,
  usedSurfaces: Set<string>,
): Promise<Prompt | null> {
  const row = await drawVocabRow(db, "produce", usedSurfaces);
  if (row === null) return null;
  return vocabProductionPrompt(row, { isNew: true }); // never null in practice (P1.5)
}

/** One unseen kanji at the lowest level with new items; `usedKanji` keeps a session's draws distinct. */
async function drawOneKanji(db: D1Database, usedKanji: Set<string>): Promise<Prompt | null> {
  const exclude =
    usedKanji.size > 0
      ? ` AND character NOT IN (${[...usedKanji].map(() => "?").join(",")})`
      : "";
  for (const level of LEVELS) {
    const row = await db
      .prepare(
        `SELECT character,
                on_reading  AS "onReading",
                kun_reading AS "kunReading"
           FROM kanji
          WHERE level = ?
            AND NOT EXISTS (
              SELECT 1 FROM srs_state s
               WHERE s.item_key = kanji.item_id || ':' || ?
            )${exclude}
          ORDER BY RANDOM()
          LIMIT 1`,
      )
      .bind(level, "onkun", ...usedKanji)
      .first<KanjiRowLike>();
    if (row === null) continue; // level exhausted, try the next one
    usedKanji.add(row.character); // claim it even on a null prompt: no re-draws this session
    const prompt = kanjiReadingPrompt(row, { isNew: true });
    if (prompt !== null) return prompt;
    // content-driven null (0 seed rows): scan the remaining levels.
  }
  return null;
}

/**
 * One unseen vocabulary row for `direction` at the lowest level where
 * new items remain (LEVELS order = easiest first), excluding surfaces
 * already drawn this session. The row joins `usedSurfaces` on success so
 * every caller makes progress.
 */
async function drawVocabRow(
  db: D1Database,
  direction: VocabDirection,
  usedSurfaces: Set<string>,
  ignoreSrs = false,
): Promise<VocabRowLike | null> {
  const exclude =
    usedSurfaces.size > 0
      ? ` AND content NOT IN (${[...usedSurfaces].map(() => "?").join(",")})`
      : "";
  const unseen = ignoreSrs
    ? ""
    : ` AND NOT EXISTS (
          SELECT 1 FROM srs_state s
           WHERE s.item_key = 'vocab:' || vocabulary.item_id || ':' || ?
        )`;
  for (const level of LEVELS) {
    const row = await db
      .prepare(
        `SELECT content, reading, meaning, level
           FROM vocabulary
          WHERE level = ?${unseen}${exclude}
          ORDER BY RANDOM()
          LIMIT 1`,
      )
      .bind(level, ...(ignoreSrs ? [] : [direction]), ...usedSurfaces)
      .first<VocabRowLike>();
    if (row !== null) {
      usedSurfaces.add(row.content);
      return row;
    }
  }
  return null;
}

/** D3 safety net — see drawNewItems; draws meaning prompts with SRS ignored. */
async function drawRegardlessOfSrs(db: D1Database): Promise<Prompt[]> {
  const usedSurfaces = new Set<string>();
  const prompts: Prompt[] = [];
  for (let attempt = 0; attempt < NEW_ITEM_COUNT + 4 && prompts.length < NEW_ITEM_COUNT; attempt++) {
    const row = await drawVocabRow(db, "meaning", usedSurfaces, true);
    if (row === null) break; // unseeded DB (Phase-0 invariant violated)
    const prompt = vocabMeaningPrompt(row, { isNew: true });
    if (prompt !== null) prompts.push(prompt);
  }
  return prompts;
}

// ─── adaptation note (§4 rule 4) ─────────────────────────────────────

/**
 * One human sentence about what the draw focused on and why, in API.md
 * example style ("New items focus: kanji readings (weakest 7d: 60%)").
 * Always describes the bucket actually drawn, not merely the weakest.
 */
function adaptationNote(
  bucket: Bucket | null,
  accuracies: BucketAccuracies,
  weakest: Bucket | null,
): string {
  if (bucket === null) {
    return "New items: the content bank has nothing left to draw";
  }
  const label = BUCKET_LABELS[bucket];
  if (weakest === null) {
    return `New items focus: ${label} — no history yet, starting from the basics`;
  }
  if (weakest === bucket) {
    const percent = Math.round((accuracies[weakest] ?? 0) * 100);
    return `New items focus: ${label} (weakest 7d: ${percent}%)`;
  }
  if (weakest === "reading") {
    return `New items focus: ${label} (reading is weakest, passages arrive later)`;
  }
  return `New items focus: ${label} (${BUCKET_LABELS[weakest]} has no unseen items left)`;
}

// ─── helpers ─────────────────────────────────────────────────────────

/** SQLite `datetime('now')` format — matches `created_at`'s column default. */
function sqliteDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** Previous UTC calendar day of a `YYYY-MM-DD` string. */
function previousUtcDay(day: string): string {
  const midnight = new Date(`${day}T00:00:00.000Z`).getTime();
  return new Date(midnight - MS_PER_DAY).toISOString().slice(0, 10);
}





