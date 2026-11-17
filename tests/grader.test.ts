// P1.4 — grading rules: one case per rule path (hit, miss,
// multi-alternative, partial→shaky) plus the full production merge
// matrix. The seed-grounded negatives ("thing" vs `in`, "news" vs `new`)
// pin D-8 — token-sequence matching, never substring containment — and
// the parenthetical case pins D-7 at the grader level.
import { describe, expect, it } from "vitest";
import { type GradingSpec, gradeAnswer } from "../src/worker/grader";

describe("keyword rule (recall/meaning)", () => {
  const everyMorning: GradingSpec = { rule: "keyword", alternatives: ["every morning"] };

  it("grades an exact hit correct", () => {
    expect(gradeAnswer(everyMorning, "every morning").grade).toBe("correct");
  });

  it("grades case/punctuation variants correct (normalized equality)", () => {
    expect(gradeAnswer(everyMorning, "Every Morning!").grade).toBe("correct");
    expect(gradeAnswer(everyMorning, "  every   morning  ").grade).toBe("correct");
  });

  it("grades a space-less answer correct (D-8 equality path)", () => {
    expect(gradeAnswer(everyMorning, "everymorning").grade).toBe("correct");
  });

  it("grades answer⊃keyword and keyword⊃answer containment correct (§2 'or vice versa')", () => {
    expect(gradeAnswer(everyMorning, "I wake up every morning, early").grade).toBe("correct");
    expect(gradeAnswer(everyMorning, "morning").grade).toBe("correct");
  });

  it("grades any of multiple alternatives correct", () => {
    const spec: GradingSpec = { rule: "keyword", alternatives: ["first", "new"] };
    expect(gradeAnswer(spec, "new").grade).toBe("correct");
    expect(gradeAnswer(spec, "first").grade).toBe("correct");
  });

  it("splits an unsplit gloss internally (§2: split on ; and ,)", () => {
    const spec: GradingSpec = { rule: "keyword", alternatives: ["first; new"] };
    expect(gradeAnswer(spec, "new").grade).toBe("correct");
  });

  it("excludes parenthetical content from matching (D-7)", () => {
    const spec: GradingSpec = { rule: "keyword", alternatives: ["medium (size)"] };
    expect(gradeAnswer(spec, "medium").grade).toBe("correct");
    expect(gradeAnswer(spec, "size").grade).toBe("incorrect");
  });

  it("rejects substring false positives — D-8 against real seed glosses", () => {
    const atInOn: GradingSpec = {
      rule: "keyword",
      alternatives: ["at (a time or place); in; on (a point)"],
    };
    expect(gradeAnswer(atInOn, "thing").grade).toBe("incorrect"); // "in" ⊄ thing
    expect(gradeAnswer(atInOn, "ink").grade).toBe("incorrect");
    expect(gradeAnswer(atInOn, "in").grade).toBe("correct"); // exact keyword still hits
    expect(gradeAnswer(atInOn, "at").grade).toBe("correct");

    const firstNew: GradingSpec = { rule: "keyword", alternatives: ["first; new"] };
    expect(gradeAnswer(firstNew, "news").grade).toBe("incorrect"); // "new" ⊄ news
    expect(gradeAnswer(firstNew, "newly built").grade).toBe("incorrect");

    const techArt: GradingSpec = { rule: "keyword", alternatives: ["technique; art"] };
    expect(gradeAnswer(techArt, "earth").grade).toBe("incorrect"); // "art" ⊄ earth

    const singleChar: GradingSpec = { rule: "keyword", alternatives: ["I"] };
    expect(gradeAnswer(singleChar, "this").grade).toBe("incorrect"); // "i" ⊄ this
    expect(gradeAnswer(singleChar, "i").grade).toBe("correct");
  });

  it("grades partial token overlap shaky, not incorrect (D-4)", () => {
    expect(gradeAnswer(everyMorning, "morning workout early").grade).toBe("shaky");
    expect(gradeAnswer(everyMorning, "exercise").grade).toBe("incorrect"); // zero overlap
  });

  it("grades empty/whitespace/punctuation-only answers incorrect", () => {
    expect(gradeAnswer(everyMorning, "").grade).toBe("incorrect");
    expect(gradeAnswer(everyMorning, "   ").grade).toBe("incorrect");
    expect(gradeAnswer(everyMorning, "!!!").grade).toBe("incorrect");
  });

  it("carries the raw expected answer for the learning moment", () => {
    const spec: GradingSpec = { rule: "keyword", alternatives: ["first", "new"] };
    expect(gradeAnswer(spec, "news").correctAnswer).toBe("first; new");
  });

  it("ignores self-grade on recall prompts", () => {
    expect(gradeAnswer(everyMorning, "nonsense", "solid").grade).toBe("incorrect");
    expect(gradeAnswer(everyMorning, "every morning", "wrong").grade).toBe("correct");
  });
});

describe("normalized exact rule (recall/reading, kanji_reading)", () => {
  const asa: GradingSpec = { rule: "normalized_exact", alternatives: ["まいあさ"] };

  it("grades an exact hit correct", () => {
    expect(gradeAnswer(asa, "まいあさ").grade).toBe("correct");
  });

  it("grades katakana↔hiragana and width/whitespace variants correct", () => {
    expect(gradeAnswer(asa, "マイアサ").grade).toBe("correct"); // kana fold
    expect(gradeAnswer(asa, "まい あさ").grade).toBe("correct"); // whitespace stripped
    expect(gradeAnswer(asa, "まい　あさ").grade).toBe("correct"); // U+3000
  });

  it("accepts any reading alternative (on/kun)", () => {
    const spec: GradingSpec = { rule: "normalized_exact", alternatives: ["いち", "ひと"] };
    expect(gradeAnswer(spec, "ひと").grade).toBe("correct");
    expect(gradeAnswer(spec, "イチ").grade).toBe("correct");
    expect(gradeAnswer(spec, "に").grade).toBe("incorrect");
  });

  it("grades a different reading and an empty answer incorrect", () => {
    expect(gradeAnswer(asa, "あさ").grade).toBe("incorrect");
    expect(gradeAnswer(asa, "").grade).toBe("incorrect");
  });

  it("carries the expected reading for the learning moment", () => {
    expect(gradeAnswer(asa, "あさ").correctAnswer).toBe("まいあさ");
  });
});

describe("production rule (§2 merge matrix)", () => {
  const spec: GradingSpec = { rule: "production", must_contain: ["合図"] };
  const answer = "彼は合図をくれました。";

  it("grades the full merge matrix", () => {
    expect(gradeAnswer(spec, answer, "solid").grade).toBe("correct");
    expect(gradeAnswer(spec, answer, "shaky").grade).toBe("shaky");
    expect(gradeAnswer(spec, answer, "wrong").grade).toBe("incorrect");
    expect(gradeAnswer(spec, "", "solid").grade).toBe("incorrect"); // checks fail
    expect(gradeAnswer(spec, "", "shaky").grade).toBe("incorrect");
    expect(gradeAnswer(spec, "", "wrong").grade).toBe("incorrect");
  });

  it("never credits correct without a self-grade (null → shaky on pass)", () => {
    expect(gradeAnswer(spec, answer, null).grade).toBe("shaky");
    expect(gradeAnswer(spec, "", null).grade).toBe("incorrect");
    expect(gradeAnswer(spec, answer).grade).toBe("shaky"); // default param
  });

  it("exposes per-token checks for the UX ✓/✗ line", () => {
    expect(gradeAnswer(spec, answer, "wrong").checks).toEqual([{ value: "合図", passed: true }]);
    expect(gradeAnswer(spec, "雨だった", "solid").checks).toEqual([
      { value: "合図", passed: false },
    ]);
  });

  it("compares must_contain through normalization (width/kana fold)", () => {
    const spec2: GradingSpec = { rule: "production", must_contain: ["ここ"] };
    expect(gradeAnswer(spec2, "ココに行った", "solid").grade).toBe("correct"); // katakana target
    expect(gradeAnswer(spec2, "　ここ ", "solid").grade).toBe("correct"); // spaces stripped
  });

  it("requires every must_contain token (all-or-nothing checks)", () => {
    const spec3: GradingSpec = { rule: "production", must_contain: ["合図", "出す"] };
    expect(gradeAnswer(spec3, "合図を出す", "solid").grade).toBe("correct");
    expect(gradeAnswer(spec3, "合図をした", "solid").grade).toBe("incorrect");
    expect(gradeAnswer(spec3, "合図をした", "solid").checks).toEqual([
      { value: "合図", passed: true },
      { value: "出す", passed: false },
    ]);
  });

  it("carries the required tokens as correctAnswer", () => {
    expect(gradeAnswer(spec, "", "wrong").correctAnswer).toBe("合図");
  });
});

describe("robustness (total function)", () => {
  it("grades an unknown rule incorrect instead of throwing", () => {
    const bogus = { rule: "multiple_choice", alternatives: ["a"] } as unknown as GradingSpec;
    const result = gradeAnswer(bogus, "a");
    expect(result.grade).toBe("incorrect");
    expect(result.correctAnswer).toBe("");
  });

  it("grades an empty production spec as passing checks (vacuous every)", () => {
    const spec: GradingSpec = { rule: "production", must_contain: [] };
    expect(gradeAnswer(spec, "anything", "solid").grade).toBe("correct");
    expect(gradeAnswer(spec, "anything", null).grade).toBe("shaky");
  });
});

