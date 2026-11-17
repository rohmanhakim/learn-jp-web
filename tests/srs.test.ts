// P1.2 — SM-2 kernel: every grade path in the Phase-001.md acceptance
// table (first rep, second rep, mature, shaky, incorrect, ease floor,
// new-item defaults), plus the D-6 lapse-recovery ladder and purity.
import { describe, expect, it } from "vitest";
import { applyGrade, initialSrsState, type SrsState } from "../src/worker/srs";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const NOW_ISO = "2026-06-15T12:00:00.000Z";

function state(overrides: Partial<SrsState> = {}): SrsState {
  return { ...initialSrsState(NOW), ...overrides };
}

describe("initialSrsState (new item defaults, §1)", () => {
  it("starts at interval 0, due now, ease 2.5", () => {
    expect(initialSrsState(NOW)).toEqual({
      ease: 2.5,
      intervalDays: 0,
      dueAt: NOW_ISO,
      reps: 0,
      lapses: 0,
      lastGrade: null,
    });
  });
});

describe("applyGrade — correct", () => {
  it("first rep: reps 0→1, interval 1 day", () => {
    const next = applyGrade(state(), "correct", NOW);
    expect(next).toEqual({
      ease: 2.5,
      intervalDays: 1,
      dueAt: "2026-06-16T12:00:00.000Z",
      reps: 1,
      lapses: 0,
      lastGrade: "correct",
    });
  });

  it("second rep: reps 1→2, interval 3 days", () => {
    const next = applyGrade(state({ reps: 1, intervalDays: 1 }), "correct", NOW);
    expect(next.intervalDays).toBe(3);
    expect(next.reps).toBe(2);
    expect(next.dueAt).toBe("2026-06-18T12:00:00.000Z");
    expect(next.ease).toBe(2.5);
  });

  it("second rep always lands on 3, even if shaky left a fractional interval", () => {
    const next = applyGrade(state({ reps: 1, intervalDays: 1.2, ease: 2.45 }), "correct", NOW);
    expect(next.intervalDays).toBe(3);
    expect(next.ease).toBe(2.45); // ease untouched by correct
  });

  it("mature rep: round(previous × ease), ease unchanged", () => {
    const next = applyGrade(state({ reps: 4, intervalDays: 10, ease: 2.5 }), "correct", NOW);
    expect(next.intervalDays).toBe(25); // round(10 × 2.5)
    expect(next.reps).toBe(5);
    expect(next.ease).toBe(2.5);
    expect(next.dueAt).toBe("2026-07-10T12:00:00.000Z");
  });

  it("mature rep rounds half up (3 × 2.5 → 8)", () => {
    const next = applyGrade(state({ reps: 2, intervalDays: 3, ease: 2.5 }), "correct", NOW);
    expect(next.intervalDays).toBe(8); // round(7.5)
    expect(next.reps).toBe(3);
  });

  it("does not touch lapses", () => {
    const next = applyGrade(state({ reps: 3, intervalDays: 8, lapses: 2 }), "correct", NOW);
    expect(next.lapses).toBe(2);
  });
});

describe("applyGrade — shaky", () => {
  it("grows the interval ×1.2, eases −0.05, keeps reps", () => {
    const next = applyGrade(state({ reps: 2, intervalDays: 3, ease: 2.5 }), "shaky", NOW);
    expect(next.intervalDays).toBeCloseTo(3.6, 10); // 3 × 1.2
    expect(next.ease).toBe(2.45);
    expect(next.reps).toBe(2);
    expect(next.lapses).toBe(0);
    expect(next.lastGrade).toBe("shaky");
    expect(next.dueAt).toBe("2026-06-19T02:24:00.000Z"); // now + 3.6 d
  });

  it("floors the interval at 1 day", () => {
    const next = applyGrade(state({ intervalDays: 0 }), "shaky", NOW);
    expect(next.intervalDays).toBe(1);
    expect(next.dueAt).toBe("2026-06-16T12:00:00.000Z");
  });

  it("does not count as a rep (§1: only correct does)", () => {
    const next = applyGrade(state({ reps: 0, intervalDays: 0 }), "shaky", NOW);
    expect(next.reps).toBe(0);
  });
});

describe("applyGrade — incorrect (lapse)", () => {
  it("resets the ladder, zeroes the interval, counts the lapse", () => {
    const next = applyGrade(
      state({ reps: 4, intervalDays: 10, ease: 2.3, lapses: 1 }),
      "incorrect",
      NOW,
    );
    expect(next.reps).toBe(0); // D-6
    expect(next.intervalDays).toBe(0);
    expect(next.dueAt).toBe(NOW_ISO);
    expect(next.lapses).toBe(2);
    expect(next.ease).toBeCloseTo(2.1, 10); // 2.3 − 0.20
    expect(next.lastGrade).toBe("incorrect");
  });

  it("re-walks 1 → 3 → mature after the lapse (D-6)", () => {
    let s = state({ reps: 5, intervalDays: 10, ease: 2.3 });
    s = applyGrade(s, "incorrect", NOW);
    expect(s.reps).toBe(0);
    expect(s.intervalDays).toBe(0);
    expect(s.ease).toBeCloseTo(2.1, 10);

    s = applyGrade(s, "correct", NOW); // re-entry
    expect([s.reps, s.intervalDays]).toEqual([1, 1]);

    s = applyGrade(s, "correct", NOW);
    expect([s.reps, s.intervalDays]).toEqual([2, 3]);

    s = applyGrade(s, "correct", NOW);
    expect([s.reps, s.intervalDays]).toEqual([3, 6]); // round(3 × 2.1)
    expect(s.ease).toBeCloseTo(2.1, 10);
    expect(s.lapses).toBe(1);
  });
});

describe("ease floor (§1: never below 1.3)", () => {
  it("incorrect floors a low ease", () => {
    const next = applyGrade(state({ ease: 1.35, reps: 1, intervalDays: 1 }), "incorrect", NOW);
    expect(next.ease).toBe(1.3); // 1.35 − 0.20 = 1.15… → floor
  });

  it("shaky floors a low ease", () => {
    const next = applyGrade(state({ ease: 1.32, reps: 1, intervalDays: 1 }), "shaky", NOW);
    expect(next.ease).toBe(1.3); // 1.32 − 0.05 = 1.27 → floor
  });

  it("an already-floored ease stays put through further lapses", () => {
    const next = applyGrade(state({ ease: 1.3, reps: 3, intervalDays: 8 }), "incorrect", NOW);
    expect(next.ease).toBe(1.3);
    expect(next.lapses).toBe(1); // the rest of the lapse still applies
    expect(next.reps).toBe(0);
  });
});

describe("purity", () => {
  it("does not mutate the input state", () => {
    const before = state({ reps: 3, intervalDays: 8, ease: 2.5, lapses: 1 });
    const snapshot = structuredClone(before);
    applyGrade(before, "shaky", NOW);
    applyGrade(before, "incorrect", NOW);
    applyGrade(before, "correct", NOW);
    expect(before).toEqual(snapshot);
  });
});
