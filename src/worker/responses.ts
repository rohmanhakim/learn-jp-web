// P1.10 — `POST /api/responses` payload (Phase-001.md Milestone C): the
// write side of the loop. One batch per call, graded SERVER-SIDE (§2:
// all normalization/grading happens server-side, even online), then
// SM-2 applied and both tables written — `srs_state` upserted,
// `responses` inserted — exactly once per `response_uuid`.
//
// Idempotency (API.md "Idempotency rules"): `responses.client_uuid` is
// the client's UNIQUE key, so every item is SELECTed BEFORE it is
// written. A known UUID answers `duplicate: true` with NO writes at
// all: `grade` comes from the stored row, the display fields
// (`correct_answer` / `checks`) are recomputed from the snapshot's
// grading spec + the stored answer — `gradeAnswer` is pure, so they are
// byte-identical to the original result — and `srs` is read from the
// CURRENT `srs_state` row (decision recorded in Phase-001.md Notes).
// A UNIQUE race inside `db.batch` falls back to the same path, like
// P1.9's session insert.
//
// Partial success is the contract (API.md): results are per-item, so a
// mid-batch duplicate is reported for that item only while the rest of
// the batch still lands. The exceptions — unknown session, a
// `prompt_key` outside the stored snapshot, an `item_key` that does not
// match its `prompt_key`, and Phase-3 `unknown_word` capture (D-5) —
// reject the WHOLE request with 400 `invalid_request` BEFORE any write,
// because `responseResultSchema` has no per-item error field and a
// half-applied batch must never be observable.
//
// Snapshot is the source of truth: the grading spec, the prompt `kind`
// (→ `srs_state.kind`) and the `bucket` stored on the response all come
// from what the server actually served, never from the client echo — a
// bad client cannot poison bucket accuracy (§3) that way.
//
// Fast-skip (D-1): `kind_hint = "fast_skip"` writes a `responses` row
// with `answer`/`grade` NULL plus an `srs_state` row with
// `suspended = 1` and `due_at = now + 30d` (LEARNING-DESIGN §1). The
// endpoint does NOT re-check `fast_skip_available` — by definition the
// session row exists by the time answers arrive, so the gate lives in
// the P1.15 UI; here a pre-existing SRS row keeps its counters and only
// gets suspended/rescheduled.
//
// DB access: raw `D1Database` SQL (repo precedent — session-builder.ts,
// status.ts, session-start.ts). `now` is a parameter; the route owns
// the real clock (P1.8/P1.9 convention). Per-item writes run in one
// `db.batch` each — D1 batches are transactional, so the UUID claim and
// the SRS application can never half-commit.

import {
  type PromptWire,
  type ResponseItem,
  type ResponseResult,
  type ResponsesRequest,
  type ResponsesResponse,
  type SessionSnapshotWire,
  sessionSnapshotSchema,
} from "./api-types";
import { gradeAnswer } from "./grader";
import { type Grade, type SelfGrade, isGrade, isSelfGrade, itemKeyFromPromptKey } from "./keys";
import { applyGrade, initialSrsState, type SrsState } from "./srs";

const MS_PER_DAY = 86_400_000;
/** LEARNING-DESIGN §1 fast-skip: park a known item for 30 days. */
const FAST_SKIP_DAYS = 30;

/**
 * A request-side contract violation the CLIENT must see as 400
 * (`invalid_request`, P1.9's pinned code) — distinct from corruption or
 * infrastructure failure, which surfaces as 500 `internal_error`.
 */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

interface SessionRow {
  id: number;
  snapshot: string;
}

interface StoredResponseRow {
  client_uuid: string;
  prompt_key: string;
  item_key: string | null;
  answer: string | null;
  grade: string | null;
  self_grade: string | null;
  kind_hint: string | null;
}

interface SrsRow {
  ease: number;
  interval_days: number;
  due_at: string;
  reps: number;
  lapses: number;
  suspended: number;
  last_grade: string | null;
}

const INSERT_RESPONSE = `INSERT INTO responses
    (session_id, client_uuid, prompt_key, item_key, answer, grade, self_grade, bucket, latency_ms, kind_hint)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPSERT_SRS = `INSERT INTO srs_state
    (item_key, kind, ease, interval_days, due_at, reps, lapses, suspended, last_grade, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(item_key) DO UPDATE SET
    kind = excluded.kind, ease = excluded.ease,
    interval_days = excluded.interval_days, due_at = excluded.due_at,
    reps = excluded.reps, lapses = excluded.lapses,
    suspended = excluded.suspended, last_grade = excluded.last_grade,
    updated_at = datetime('now')`;

/**
 * The session row for a `session_uuid`, with its snapshot parsed
 * through the P1.7 wire schema. Unknown UUID → `InvalidRequestError`
 * (400); a snapshot that no longer parses is corruption → plain throw
 * (500), mirroring P1.9's `storedSession`.
 */
async function loadSession(
  db: D1Database,
  sessionUuid: string,
): Promise<{ id: number; snapshot: SessionSnapshotWire }> {
  const row = await db
    .prepare("SELECT id, snapshot FROM sessions WHERE client_uuid = ?")
    .bind(sessionUuid)
    .first<SessionRow>();
  if (row === null) throw new InvalidRequestError(`unknown session_uuid: ${sessionUuid}`);
  return { id: row.id, snapshot: sessionSnapshotSchema.parse(JSON.parse(row.snapshot)) };
}

/** The served prompt for a `prompt_key` — 400 when it is not in this session. */
function promptFor(snapshot: SessionSnapshotWire, promptKey: string): PromptWire {
  const prompt = snapshot.prompts.find((p) => p.prompt_key === promptKey);
  if (prompt === undefined) {
    throw new InvalidRequestError(`prompt_key not in this session's snapshot: ${promptKey}`);
  }
  return prompt;
}

/**
 * Validate one item against the stored snapshot BEFORE anything is
 * written (the batch is validated whole, then processed). Returns the
 * served prompt the item is graded/scheduled against.
 */
function validateItem(snapshot: SessionSnapshotWire, item: ResponseItem): PromptWire {
  if (item.kind_hint === "unknown_word") {
    // D-5: the contract accepts the variant, but capture needs passages
    // and its own storage path — Phase 3.
    throw new InvalidRequestError(`unknown-word capture is deferred to Phase 3 (D-5): ${item.prompt_key}`);
  }
  const prompt = promptFor(snapshot, item.prompt_key);
  const derived = itemKeyFromPromptKey(item.prompt_key);
  if (derived === null || derived !== item.item_key) {
    throw new InvalidRequestError(
      `item_key mismatch for ${item.prompt_key}: expected ${derived ?? "no SRS identity"}, got ${item.item_key}`,
    );
  }
  if (item.kind_hint === undefined && prompt.grading === undefined) {
    // Only passage questions omit `grading` (graded by answer_index) —
    // they do not exist before Phase 3.
    throw new InvalidRequestError(`prompt carries no grading spec: ${item.prompt_key}`);
  }
  return prompt;
}

async function storedResponse(db: D1Database, responseUuid: string): Promise<StoredResponseRow | null> {
  return db
    .prepare(
      `SELECT client_uuid, prompt_key, item_key, answer, grade, self_grade, kind_hint
         FROM responses WHERE client_uuid = ?`,
    )
    .bind(responseUuid)
    .first<StoredResponseRow>();
}

async function loadSrs(db: D1Database, itemKey: string): Promise<SrsRow | null> {
  return db
    .prepare(
      `SELECT ease, interval_days, due_at, reps, lapses, suspended, last_grade
         FROM srs_state WHERE item_key = ?`,
    )
    .bind(itemKey)
    .first<SrsRow>();
}

function selfGradeOf(value: string | null): SelfGrade | null {
  return value !== null && isSelfGrade(value) ? value : null;
}

function toSrsState(row: SrsRow): SrsState {
  return {
    ease: row.ease,
    intervalDays: row.interval_days,
    dueAt: row.due_at,
    reps: row.reps,
    lapses: row.lapses,
    lastGrade: row.last_grade !== null && isGrade(row.last_grade) ? row.last_grade : null,
  };
}

/**
 * Rebuild the original result for a replayed `response_uuid` without
 * touching any state: stored `grade`, display fields recomputed
 * deterministically, `srs` read as it stands NOW. A recomputed grade
 * that disagrees with the stored one means snapshot and row diverged —
 * corruption, so it throws (500) instead of serving a wrong moment.
 */
async function duplicateResult(
  db: D1Database,
  snapshot: SessionSnapshotWire,
  row: StoredResponseRow,
): Promise<ResponseResult> {
  const result: ResponseResult = { response_uuid: row.client_uuid, duplicate: true };
  if (row.kind_hint === null && row.grade !== null) {
    if (!isGrade(row.grade)) throw new Error(`stored grade is not a grade: ${row.grade}`);
    result.grade = row.grade as Grade;
    const prompt = snapshot.prompts.find((p) => p.prompt_key === row.prompt_key);
    if (prompt?.grading !== undefined) {
      const graded = gradeAnswer(prompt.grading, row.answer ?? "", selfGradeOf(row.self_grade));
      if (graded.grade !== row.grade) {
        throw new Error(
          `recomputed grade ${graded.grade} disagrees with stored ${row.grade} for ${row.prompt_key}`,
        );
      }
      result.correct_answer = graded.correctAnswer;
      if (graded.checks !== undefined) result.checks = graded.checks;
    }
  }
  const srs = row.item_key === null ? null : await loadSrs(db, row.item_key);
  if (srs !== null) result.srs = { due_at: srs.due_at, interval_days: srs.interval_days };
  return result;
}

/**
 * Grade → SM-2 → write, as one transaction: claim the UUID and apply
 * the schedule together. Returns the result the client shows inline
 * (UX.md learning moment: `grade`, `correct_answer`, `checks`).
 */
async function applyGraded(
  db: D1Database,
  snapshot: SessionSnapshotWire,
  now: Date,
  sessionId: number,
  item: Extract<ResponseItem, { kind_hint?: undefined }>,
  prompt: PromptWire,
): Promise<ResponseResult> {
  // validateItem guarantees a spec; `!` keeps that invariant local.
  const graded = gradeAnswer(prompt.grading!, item.answer, item.self_grade);

  const existing = await loadSrs(db, item.item_key);
  const next = applyGrade(existing === null ? initialSrsState(now) : toSrsState(existing), graded.grade, now);

  try {
    await db.batch([
      db
        .prepare(INSERT_RESPONSE)
        .bind(
          sessionId,
          item.response_uuid,
          item.prompt_key,
          item.item_key,
          item.answer,
          graded.grade,
          item.self_grade,
          prompt.bucket,
          item.latency_ms ?? null,
          null,
        ),
      db
        .prepare(UPSERT_SRS)
        .bind(
          item.item_key,
          prompt.kind,
          next.ease,
          next.intervalDays,
          next.dueAt,
          next.reps,
          next.lapses,
          // A graded answer never un-suspends: fast-skip owns that flag.
          existing?.suspended ?? 0,
          next.lastGrade,
        ),
    ]);
  } catch (err) {
    const raced = await storedResponse(db, item.response_uuid);
    if (raced !== null) return duplicateResult(db, snapshot, raced);
    throw err;
  }

  return {
    response_uuid: item.response_uuid,
    duplicate: false,
    grade: graded.grade,
    correct_answer: graded.correctAnswer,
    ...(graded.checks === undefined ? {} : { checks: graded.checks }),
    srs: { due_at: next.dueAt, interval_days: next.intervalDays },
  };
}

/**
 * D-1 fast-skip: record the skip (so Done can tell it from an
 * abandonment) and park the item — suspended, due in 30 days — without
 * touching its learning history.
 */
async function applyFastSkip(
  db: D1Database,
  snapshot: SessionSnapshotWire,
  now: Date,
  sessionId: number,
  item: Extract<ResponseItem, { kind_hint: "fast_skip" }>,
  prompt: PromptWire,
): Promise<ResponseResult> {
  const existing = await loadSrs(db, item.item_key);
  const base = existing === null ? initialSrsState(now) : toSrsState(existing);
  const dueAt = new Date(now.getTime() + FAST_SKIP_DAYS * MS_PER_DAY).toISOString();

  try {
    await db.batch([
      db
        .prepare(INSERT_RESPONSE)
        .bind(
          sessionId,
          item.response_uuid,
          item.prompt_key,
          item.item_key,
          null,
          null,
          null,
          prompt.bucket,
          item.latency_ms ?? null,
          "fast_skip",
        ),
      db
        .prepare(UPSERT_SRS)
        .bind(item.item_key, prompt.kind, base.ease, base.intervalDays, dueAt, base.reps, base.lapses, 1, base.lastGrade),
    ]);
  } catch (err) {
    const raced = await storedResponse(db, item.response_uuid);
    if (raced !== null) return duplicateResult(db, snapshot, raced);
    throw err;
  }

  // API.md: a fast-skip result carries `duplicate` and `srs` only.
  return {
    response_uuid: item.response_uuid,
    duplicate: false,
    srs: { due_at: dueAt, interval_days: base.intervalDays },
  };
}

/**
 * Process one API.md `responses` batch: validate everything, then
 * grade/record item by item.
 *
 * @param db       D1 binding (same instance the builder queries).
 * @param now      Current time — injected so tests are deterministic.
 * @param request  Validated API.md `POST /api/responses` body.
 * @throws {InvalidRequestError} whole-batch contract violation (400).
 */
export async function saveResponses(
  db: D1Database,
  now: Date,
  request: ResponsesRequest,
): Promise<ResponsesResponse> {
  const session = await loadSession(db, request.session_uuid);

  // Phase 1: reject before writing — a 400 must leave zero rows.
  const prompts = request.responses.map((item) => validateItem(session.snapshot, item));

  const results: ResponseResult[] = [];
  for (const [index, item] of request.responses.entries()) {
    const prompt = prompts[index]!; // same length, validated above

    const stored = await storedResponse(db, item.response_uuid);
    if (stored !== null) {
      // Replays and mid-batch repeats both land here — no writes.
      results.push(await duplicateResult(db, session.snapshot, stored));
      continue;
    }

    if (item.kind_hint === "fast_skip") {
      results.push(await applyFastSkip(db, session.snapshot, now, session.id, item, prompt));
    } else if (item.kind_hint === undefined) {
      results.push(await applyGraded(db, session.snapshot, now, session.id, item, prompt));
    } else {
      // Unreachable: validateItem rejected `unknown_word` above — the
      // branch exists purely to narrow the union for TypeScript.
      throw new InvalidRequestError(`unknown-word capture is deferred to Phase 3 (D-5): ${item.prompt_key}`);
    }
  }

  return { results };
}