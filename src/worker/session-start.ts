// P1.9 — `POST /api/session/start` payload (Phase-001.md Milestone C):
// compose one session with the P1.6 builder, persist it, and answer with
// API.md's `session/start` body (snapshot + transport fields).
//
// Idempotency (API.md "Idempotency rules"): `sessions.client_uuid` is the
// client's UNIQUE key, so the handler SELECTs BEFORE it builds — a replay
// answers from the STORED snapshot and never recomposes, because DATA-MODEL
// requires `sessions.snapshot` to keep "exactly what was served" (a fresh
// composition could differ: different `now` ⇒ different due set, and
// `fast_skip_available` already flipped to false once a row exists). A
// fresh start INSERTs the builder's snapshot and returns that same body; a
// UNIQUE violation from a concurrent replay falls back to the stored row.
//
// `title` = `Session N · 10–15 min` (API.md's example): N is the row's
// ORDINAL (`COUNT(*) … WHERE id <= row.id`), NOT `COUNT(*)` at response
// time — rows are never deleted (DATA-MODEL "Retention & integrity"), so an
// ordinal is stable under replay and after later sessions start, which is
// exactly what acceptance (b)'s "identical body" needs. The duration
// segment is a literal: `max_minutes` is a hint the server may ignore
// (API.md) and builder v1 has no time-based composition.
//
// Storage: `snapshot` is written as `JSON.stringify(snapshot)` verbatim and
// the response re-serves the parsed snapshot — one source of truth, so what
// was stored and what was sent can never drift. `started_at` is UTC
// ISO-8601 (DATA-MODEL), like every other stored timestamp; `now` is a
// parameter (srs.ts / session-builder.ts convention) and the route owns the
// real clock, exactly as in P1.8.
//
// DB access: raw `D1Database` SQL (repo precedent — session-builder.ts,
// status.ts, index.ts).

import {
  type SessionStartRequest,
  type SessionStartResponse,
  type SessionSnapshotWire,
  sessionSnapshotSchema,
} from "./api-types";
import { buildSession } from "./session-builder";

/** Literal duration segment of the title — builder v1 has no time budget. */
const TITLE_DURATION = "10–15 min";

/** `Session N · 10–15 min` — API.md's documented title shape. */
export function sessionTitle(n: number): string {
  return `Session ${n} · ${TITLE_DURATION}`;
}

interface SessionRow {
  id: number;
  snapshot: string;
}

/**
 * Position of a session among all sessions (1-based). Stable for the row's
 * lifetime: rows are never deleted, so a replayed start recomputes the very
 * same N it originally served.
 */
async function sessionOrdinal(db: D1Database, id: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE id <= ?")
    .bind(id)
    .first<{ n: number }>();
  if (row === null) throw new Error(`session ${id} vanished before it could be numbered`);
  return row.n;
}

async function respond(
  db: D1Database,
  sessionUuid: string,
  id: number,
  snapshot: SessionSnapshotWire,
): Promise<SessionStartResponse> {
  return {
    session_uuid: sessionUuid,
    title: sessionTitle(await sessionOrdinal(db, id)),
    ...snapshot,
  };
}

/**
 * The stored body for an already-known `session_uuid`, or `null` when this
 * UUID has never been started. The stored snapshot is parsed through the
 * P1.7 wire schema — it was written by this module, so a parse failure means
 * corruption and must surface, not be silently re-composed.
 */
async function storedSession(
  db: D1Database,
  sessionUuid: string,
): Promise<SessionStartResponse | null> {
  const row = await db
    .prepare("SELECT id, snapshot FROM sessions WHERE client_uuid = ?")
    .bind(sessionUuid)
    .first<SessionRow>();
  if (row === null) return null;
  const snapshot = sessionSnapshotSchema.parse(JSON.parse(row.snapshot));
  return respond(db, sessionUuid, row.id, snapshot);
}

/**
 * Compose and persist one session, idempotently on `session_uuid`.
 *
 * @param db       D1 binding (same instance the builder queries).
 * @param now      Current time — injected so tests are deterministic.
 * @param request  Validated API.md `session/start` request.
 */
export async function startSession(
  db: D1Database,
  now: Date,
  request: SessionStartRequest,
): Promise<SessionStartResponse> {
  const existing = await storedSession(db, request.session_uuid);
  if (existing !== null) return existing;

  const snapshot = await buildSession(db, now);

  let row: SessionRow | null;
  try {
    row = await db
      .prepare(
        `INSERT INTO sessions (client_uuid, started_at, snapshot)
         VALUES (?, ?, ?) RETURNING id, snapshot`,
      )
      .bind(request.session_uuid, now.toISOString(), JSON.stringify(snapshot))
      .first<SessionRow>();
  } catch (err) {
    // UNIQUE race with a concurrent replay of the same UUID: answer from
    // the row that won the insert — no double row, same body.
    const raced = await storedSession(db, request.session_uuid);
    if (raced !== null) return raced;
    throw err;
  }
  if (row === null) throw new Error("session insert returned no row");

  return respond(db, request.session_uuid, row.id, snapshot);
}
