// P1.8 — `GET /api/status` payload (Phase-001.md Milestone C): the Home
// screen's data per API.md, composed from the SHARED P1.6 helpers so
// `streak_days`, `due_count` and `weakest_bucket` can never drift from
// what the session builder serves (Phase-001.md Notes requirement:
// single implementation, never a second copy).
//
// Only two queries here have no builder counterpart, because they are
// status-specific:
//   - `last_session` = MAX(completed_at) over COMPLETED sessions —
//     abandoned rows keep `completed_at = NULL` (DATA-MODEL "Retention
//     & integrity") and never show as activity, matching API.md's
//     first-run note ("no session has completed yet" ⇒ null).
//   - `totals` = live content-bank sizes in one scalar-subquery row;
//     `passages` stays 0 until Phase 3 ships content (D-2).
//
// DB access: raw `D1Database` SQL (repo precedent — session-builder.ts,
// index.ts). `now` is a parameter (srs.ts / session-builder.ts
// convention) so every test is deterministic; timestamps stored are
// UTC ISO-8601, so lexicographic comparison and MAX() are correct.
//
// Inherited caveat: `weakest_bucket` runs through `bucketAccuracies`,
// which filters `AND kind_hint IS NULL` (D-1) — /api/status inherits
// that filter exactly like the builder does, by construction.

import { type StatusResponse } from "./api-types";
import { bucketAccuracies, dueCount, streakDays, weakestBucket } from "./session-builder";

/**
 * Build the API.md `GET /api/status` body for the given clock.
 *
 * @param db   D1 binding (same instance the builder queries).
 * @param now  Current time — injected so streak/due/accuracy windows
 *             are reproducible in tests.
 */
export async function statusPayload(db: D1Database, now: Date): Promise<StatusResponse> {
  const streak = await streakDays(db, now);
  const due = await dueCount(db, now);
  const weakest = weakestBucket(await bucketAccuracies(db, now));

  const activity = await db
    .prepare("SELECT MAX(completed_at) AS last_session FROM sessions WHERE completed_at IS NOT NULL")
    .first<{ last_session: string | null }>();

  const totals = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM vocabulary) AS vocabulary,
              (SELECT COUNT(*) FROM kanji)      AS kanji,
              (SELECT COUNT(*) FROM passages)   AS passages`,
    )
    .first<{ vocabulary: number; kanji: number; passages: number }>();

  return {
    streak_days: streak,
    last_session: activity?.last_session ?? null,
    due_count: due,
    totals: {
      vocabulary: totals?.vocabulary ?? 0,
      kanji: totals?.kanji ?? 0,
      passages: totals?.passages ?? 0,
    },
    weakest_bucket: weakest,
  };
}