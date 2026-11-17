// P1.2 — SM-2 kernel (Phase-001.md Milestone A): the scheduling rule
// of LEARNING-DESIGN §1 as one pure function. No DB, no HTTP, no
// hidden inputs — `now` is a parameter, so every test is deterministic.
//
// State mirrors the `srs_state` scheduling columns (DATA-MODEL.md) in
// Drizzle camelCase; `item_key`, `kind` and `suspended` belong to the
// caller (row identity / fast-skip), so the returned state spreads
// straight into a row update at the /api/responses layer (P1.10).
//
// Always set `dueAt` explicitly as UTC ISO-8601 — never fall back to
// the column's `datetime('now')` default — so lexicographic
// `due_at <= ?` comparisons always see a single format.

import type { Grade } from "./keys";

/** Scheduling slice of one `srs_state` row (DATA-MODEL.md). */
export interface SrsState {
  /** Ease factor; floor 1.3 (§1). */
  ease: number;
  /** Days until due; REAL — the `shaky` path produces fractions (§1). */
  intervalDays: number;
  /** UTC ISO-8601, matching the `due_at` TEXT column. */
  dueAt: string;
  reps: number;
  lapses: number;
  /** Last grade applied; NULL on a fresh row. */
  lastGrade: Grade | null;
}

const MS_PER_DAY = 86_400_000;
const EASE_FLOOR = 1.3;
const EASE_PENALTY_INCORRECT = 0.2;
const EASE_PENALTY_SHAKY = 0.05;
const DEFAULT_EASE = 2.5;

/** New-item defaults (§1): interval 0, due now, ease 2.5. */
export function initialSrsState(now: Date): SrsState {
  return {
    ease: DEFAULT_EASE,
    intervalDays: 0,
    dueAt: now.toISOString(),
    reps: 0,
    lapses: 0,
    lastGrade: null,
  };
}

/**
 * Apply one graded response per LEARNING-DESIGN §1 and return the next
 * state; the input is not mutated.
 *
 * Decision D-6 (Phase-001.md): `incorrect` resets `reps` to 0 so the
 * item re-enters the 1 → 3 → mature ladder — without it a lapsed item
 * would compute `round(0 × ease) = 0` and stay due forever.
 */
export function applyGrade(state: SrsState, grade: Grade, now: Date): SrsState {
  switch (grade) {
    case "incorrect":
      return {
        ease: Math.max(EASE_FLOOR, state.ease - EASE_PENALTY_INCORRECT),
        intervalDays: 0,
        dueAt: now.toISOString(),
        reps: 0, // D-6: the lapse restarts the ladder
        lapses: state.lapses + 1,
        lastGrade: grade,
      };
    case "shaky": {
      const intervalDays = Math.max(1, state.intervalDays * 1.2);
      return {
        ease: Math.max(EASE_FLOOR, state.ease - EASE_PENALTY_SHAKY),
        intervalDays,
        dueAt: dueIn(now, intervalDays),
        reps: state.reps, // §1: only `correct` earns a rep
        lapses: state.lapses,
        lastGrade: grade,
      };
    }
    case "correct": {
      const reps = state.reps + 1;
      const intervalDays =
        reps === 1 ? 1 : reps === 2 ? 3 : Math.round(state.intervalDays * state.ease);
      return {
        ease: state.ease,
        intervalDays,
        dueAt: dueIn(now, intervalDays),
        reps,
        lapses: state.lapses,
        lastGrade: grade,
      };
    }
  }
}

function dueIn(now: Date, intervalDays: number): string {
  // Round to whole ms: `shaky` leaves fractional days (×1.2), and float
  // dust must not leak into the stored ISO timestamp.
  return new Date(now.getTime() + Math.round(intervalDays * MS_PER_DAY)).toISOString();
}
