// P1.11 — `POST /api/session/complete` payload (Phase-001.md Milestone C):
// finalize the session row and answer with the Done screen's body
// (API.md): what was answered, plus a REAL projection of the next
// session.
//
// Idempotency: completing an already-completed session writes nothing —
// `completed_at`, `duration_sec` and `stats` are set exactly once, the
// UPDATE guarded by `WHERE completed_at IS NULL`, so a replay (or a
// concurrent race, which loses the guard with 0 rows changed) can never
// inflate a stat or re-time the session. The response body is RECOMPUTED
// on every call rather than replayed from storage: the counts derive
// from `responses` rows (derived data, never incremented), so they
// cannot double-count, and answers that land after completion (Phase
// 2's queue flushing) show up on the next call — matching UX.md's "the
// summary reflects everything once synced".
//
// Summary math: the STORED snapshot splits prompts into reviews/new
// (`is_new`); a response row counts as `done` for its side and as
// `correct` when `grade = 'correct'`. Fast-skip rows (D-1) carry
// `grade NULL` — they count as done (that is exactly why D-1 writes the
// row) but never as correct, and never in `stats.accuracy` either
// (LEARNING-DESIGN §3, `kind_hint IS NULL`).
//
// `next_session.preview` is a projection of the ACTUAL next
// `session/start`: it re-runs the P1.6 builder against the post-session
// DB state (read-only — completion changes no SRS row) and formats the
// prompt counts it would serve — API.md: "a real projection … must
// match, not approximate". `note` is hybrid: a weakness-phrased sentence
// when the projected draw IS the measured weakest bucket, otherwise the
// projection's own `adaptation_note`, whose templates already tell the
// truth about the divergent cases (no history yet; reading weakest but
// passages arrive later).
//
// `sessions.stats` follows DATA-MODEL "Session stats": counts as served,
// session-scoped accuracy over this session's graded rows only (the
// shared 7-day rolling accuracy stays builder/status-owned), and
// `buckets_practiced` in `BUCKETS` declaration order. Written once, at
// completion — an audit of that moment, never re-read by any route.
//
// DB access: raw `D1Database` SQL (repo precedent — session-start.ts,
// status.ts, session-builder.ts). `now` is a parameter (srs.ts
// convention) and the route owns the real clock (P1.8–P1.10). The
// streak is computed AFTER the completion write so today counts (D-3),
// through the SHARED `streakDays` helper — never a second copy.

import {
  type SessionCompleteRequest,
  type SessionCompleteResponse,
  type SessionSnapshotWire,
  sessionSnapshotSchema,
} from "./api-types";
import { BUCKETS, type Bucket, isGrade } from "./keys";
import { InvalidRequestError } from "./responses";
import {
  type SessionSnapshot,
  bucketAccuracies,
  bucketLabel,
  buildSession,
  streakDays,
  weakestBucket,
} from "./session-builder";

/** DATA-MODEL "Session stats" — stored in `sessions.stats`, written once. */
interface SessionStats {
  counts: { reviews: number; new: number };
  accuracy: Partial<Record<Bucket, number>>;
  buckets_practiced: Bucket[];
}

/**
 * API.md's weakness sentence per bucket (Done-screen copy — UX.md:
 * "kanji readings are your weakest right now"). Full sentences, not
 * labels, because the grammar differs per bucket ("…readings are" vs
 * "…comprehension is") and the preview's label is a bare noun phrase.
 */
const WEAKNESS_SENTENCES: Record<Bucket, string> = {
  vocab_recog: "Word meanings & readings are your weakest area right now.",
  kanji: "Kanji readings are your weakest area right now.",
  reading: "Reading comprehension is your weakest area right now.",
  writing: "Sentence production is your weakest area right now.",
};

interface SessionRow {
  id: number;
  snapshot: string;
  completed_at: string | null;
}

interface ResponseRow {
  prompt_key: string;
  grade: string | null;
  kind_hint: string | null;
}

interface Tallies {
  reviews: { done: number; correct: number };
  new: { done: number; correct: number };
  stats: SessionStats;
}

/**
 * The session row for a `session_uuid`, with its snapshot parsed through
 * the P1.7 wire schema. Unknown UUID → `InvalidRequestError` (400); a
 * snapshot that no longer parses is corruption → plain throw (500),
 * mirroring P1.10's `loadSession`.
 */
async function loadSession(
  db: D1Database,
  sessionUuid: string,
): Promise<{ id: number; completedAt: string | null; snapshot: SessionSnapshotWire }> {
  const row = await db
    .prepare("SELECT id, snapshot, completed_at FROM sessions WHERE client_uuid = ?")
    .bind(sessionUuid)
    .first<SessionRow>();
  if (row === null) throw new InvalidRequestError(`unknown session_uuid: ${sessionUuid}`);
  return {
    id: row.id,
    completedAt: row.completed_at,
    snapshot: sessionSnapshotSchema.parse(JSON.parse(row.snapshot)),
  };
}

/**
 * Done/correct counts per side (split by the snapshot's `is_new`) plus
 * the session-scoped `stats` — one pass over this session's response
 * rows. Rows whose `prompt_key` is not in the snapshot are ignored: P1.10
 * rejects those at write time, so here it is pure defensiveness.
 */
async function tally(
  db: D1Database,
  sessionId: number,
  snapshot: SessionSnapshotWire,
): Promise<Tallies> {
  const sides = new Map<string, "reviews" | "new">();
  const buckets = new Map<string, Bucket>();
  for (const prompt of snapshot.prompts) {
    sides.set(prompt.prompt_key, prompt.is_new === true ? "new" : "reviews");
    buckets.set(prompt.prompt_key, prompt.bucket);
  }

  const rows = await db
    .prepare("SELECT prompt_key, grade, kind_hint FROM responses WHERE session_id = ?")
    .bind(sessionId)
    .all<ResponseRow>();

  const done = { reviews: 0, new: 0 };
  const correct = { reviews: 0, new: 0 };
  const bucketTotals = new Map<Bucket, { correct: number; total: number }>();

  for (const row of rows.results) {
    const side = sides.get(row.prompt_key);
    if (side === undefined) continue;
    done[side] += 1;
    if (row.grade === "correct") correct[side] += 1;
    if (row.kind_hint !== null) continue; // D-1 skip: done, never graded (§3)
    if (row.grade === null || !isGrade(row.grade)) continue; // defensive, as above
    const bucket = buckets.get(row.prompt_key);
    if (bucket === undefined) continue;
    const bucketTally = bucketTotals.get(bucket) ?? { correct: 0, total: 0 };
    bucketTally.total += 1;
    if (row.grade === "correct") bucketTally.correct += 1;
    bucketTotals.set(bucket, bucketTally);
  }

  const accuracy: Partial<Record<Bucket, number>> = {};
  const bucketsPracticed: Bucket[] = [];
  for (const bucket of BUCKETS) {
    const bucketTally = bucketTotals.get(bucket);
    if (bucketTally === undefined) continue;
    bucketsPracticed.push(bucket);
    accuracy[bucket] = bucketTally.correct / bucketTally.total;
  }

  return {
    reviews: { done: done.reviews, correct: correct.reviews },
    new: { done: done.new, correct: correct.new },
    stats: {
      counts: { reviews: done.reviews, new: done.new },
      accuracy,
      buckets_practiced: bucketsPracticed,
    },
  };
}

/**
 * API.md's preview sentence: `"<N> reviews · <M> new (<label>)"` (with
 * `1 review` singularized — Done-screen copy), zero segments omitted and
 * no passage line in v1 (D-2). The label is the
 * drawn bucket's shared label when all new prompts agree (the normal
 * case — one bucket draws all three); a mixed draw falls back to the
 * bare count. D3 guarantees the builder never returns zero prompts, so
 * at least one segment always exists.
 */
function previewOf(projected: SessionSnapshot): string {
  const reviews = projected.prompts.filter((prompt) => !prompt.is_new).length;
  const fresh = projected.prompts.filter((prompt) => prompt.is_new);
  const drawn = new Set(fresh.map((prompt) => prompt.bucket));

  const segments: string[] = [];
  if (reviews > 0) segments.push(`${reviews} review${reviews === 1 ? "" : "s"}`);
  if (fresh.length > 0) {
    const label = drawn.size === 1 ? ` (${bucketLabel([...drawn][0]!)})` : "";
    segments.push(`${fresh.length} new${label}`);
  }
  return segments.join(" · ");
}

/**
 * Hybrid note: the weakness sentence when the projected draw is exactly
 * the measured weakest bucket (so the sentence is true of what the next
 * session will serve); otherwise the projection's own `adaptation_note`,
 * which already words the divergent cases (no history, reading weakest
 * with no passages, bank exhaustion).
 */
function noteOf(projected: SessionSnapshot, weakest: Bucket | null): string {
  const drawn = new Set(
    projected.prompts.filter((prompt) => prompt.is_new).map((prompt) => prompt.bucket),
  );
  if (weakest !== null && drawn.size === 1 && drawn.has(weakest)) {
    return WEAKNESS_SENTENCES[weakest];
  }
  return projected.adaptation_note;
}

/**
 * Process one API.md `POST /api/session/complete`: finalize once, then
 * answer with freshly derived summary + next-session projection.
 *
 * @param db       D1 binding (same instance the builder queries).
 * @param now      Current time — injected so tests are deterministic.
 * @param request  Validated API.md completion body.
 * @throws {InvalidRequestError} unknown `session_uuid` (400).
 */
export async function completeSession(
  db: D1Database,
  now: Date,
  request: SessionCompleteRequest,
): Promise<SessionCompleteResponse> {
  const session = await loadSession(db, request.session_uuid);
  const tallies = await tally(db, session.id, session.snapshot);

  if (session.completedAt === null) {
    await db
      .prepare(
        `UPDATE sessions SET completed_at = ?, duration_sec = ?, stats = ?
          WHERE id = ? AND completed_at IS NULL`,
      )
      .bind(now.toISOString(), request.duration_sec, JSON.stringify(tallies.stats), session.id)
      .run();
  }

  // After the write, so today's completion counts toward the run (D-3).
  const streak = await streakDays(db, now);

  // The real projection: the same builder the next start runs, read-only,
  // against the post-session DB state (completion writes no SRS row).
  const projected = await buildSession(db, now);
  const weakest = weakestBucket(await bucketAccuracies(db, now));

  return {
    summary: {
      reviews: tallies.reviews,
      new: tallies.new,
      streak_days: streak,
    },
    next_session: {
      preview: previewOf(projected),
      note: noteOf(projected, weakest),
    },
  };
}
