// P1.5 — prompt factory: golden objects for the four Phase-1 prompt
// shapes (API.md snapshot examples), key round-trips through P1.1's
// parsers (the builder ↔ /api/responses identity agreement), the seed
// data edge cases (missing readings, KANJIDIC okurigana markers, gloss
// splitting), and the ≥1-entry invariant P1.4's notes depend on.
import { describe, expect, it } from "vitest";
import { gradeAnswer } from "../src/worker/grader";
import { itemKeyFromPromptKey, parsePromptKey } from "../src/worker/keys";
import {
  type KanjiRowLike,
  type Prompt,
  type VocabRowLike,
  PROMPT_INPUTS,
  kanjiReadingPrompt,
  vocabMeaningPrompt,
  vocabProductionPrompt,
  vocabReadingPrompt,
} from "../src/worker/prompts";

// Real seed rows (data/seed/*.json) so goldens are grounded in shipped content.
const everyMorning: VocabRowLike = {
  content: "毎朝",
  reading: "まいあさ",
  meaning: "every morning",
  level: "n5",
};
const signal: VocabRowLike = {
  content: "合図",
  reading: "あいず",
  meaning: "sign; signal; Phase diagram",
  level: "n3",
};
const ichi: KanjiRowLike = {
  character: "一",
  onReading: "イチ,イツ",
  kunReading: "ひと-,ひと.つ",
};

/** The four prompts every other block reuses (always present by construction). */
const meaningPrompt = must(vocabMeaningPrompt(everyMorning, { isNew: false }));
const readingPrompt = must(vocabReadingPrompt(everyMorning, { isNew: false }));
const kanjiPrompt = must(kanjiReadingPrompt(ichi, { isNew: false }));
const productionPrompt = must(vocabProductionPrompt(signal, { isNew: true }));
const allPrompts = [meaningPrompt, readingPrompt, kanjiPrompt, productionPrompt];

/** TS-friendly `Prompt | null` guard for the always-present fixtures. */
function must(prompt: Prompt | null): Prompt {
  if (prompt === null) throw new Error("expected a prompt");
  return prompt;
}

describe("golden prompts (API.md shapes)", () => {
  it("vocab meaning prompt", () => {
    expect(meaningPrompt).toEqual({
      prompt_key: "r:jlpt:n5:毎朝:meaning",
      kind: "recall",
      bucket: "vocab_recog",
      is_new: false,
      instruction: "Type the meaning",
      stimulus: "毎朝",
      input: "text",
      grading: { rule: "keyword", alternatives: ["every morning"] },
    });
  });

  it("vocab reading prompt (EN-meaning cue, §2 primary)", () => {
    expect(readingPrompt).toEqual({
      prompt_key: "r:jlpt:n5:毎朝:reading",
      kind: "recall",
      bucket: "vocab_recog",
      is_new: false,
      instruction: "Type the reading",
      stimulus: "every morning",
      input: "text",
      grading: { rule: "normalized_exact", alternatives: ["まいあさ"] },
    });
  });

  it("kanji reading prompt (bare character, on+kun alternatives)", () => {
    expect(kanjiPrompt).toEqual({
      prompt_key: "r:kanji:一:onkun",
      kind: "recall",
      bucket: "kanji",
      is_new: false,
      instruction: "Type a reading (on or kun)",
      stimulus: "一",
      input: "text",
      grading: { rule: "normalized_exact", alternatives: ["イチ", "イツ", "ひと", "ひとつ"] },
    });
  });

  it("production prompt", () => {
    expect(productionPrompt).toEqual({
      prompt_key: "w:jlpt:n3:合図:produce",
      kind: "production",
      bucket: "writing",
      is_new: true,
      instruction: "Write a sentence using 合図",
      stimulus: "合図 (sign)",
      input: "text+selfgrade",
      grading: { rule: "production", must_contain: ["合図"] },
    });
  });
});

describe("key agreement with P1.1 (builder ↔ /api/responses)", () => {
  const expectedItemKeys = [
    "vocab:jlpt:n5:毎朝:meaning",
    "vocab:jlpt:n5:毎朝:reading",
    "kanji:一:onkun",
    "vocab:jlpt:n3:合図:produce",
  ];

  it("parses every emitted prompt_key", () => {
    for (const prompt of allPrompts) {
      expect(parsePromptKey(prompt.prompt_key)).not.toBeNull();
    }
  });

  it("maps every emitted prompt_key to the expected item_key", () => {
    expect(allPrompts.map((p) => itemKeyFromPromptKey(p.prompt_key))).toEqual(expectedItemKeys);
  });

  it("emits a legal `input` value for every prompt", () => {
    for (const prompt of allPrompts) {
      expect(PROMPT_INPUTS).toContain(prompt.input);
    }
  });
});

describe("row edge cases", () => {
  it("returns null when a reading is missing or blank", () => {
    expect(vocabReadingPrompt({ ...everyMorning, reading: null }, { isNew: false })).toBeNull();
    expect(vocabReadingPrompt({ ...everyMorning, reading: "   " }, { isNew: false })).toBeNull();
  });

  it("keeps meaning/production prompts available for a reading-less row", () => {
    const noReading: VocabRowLike = { ...everyMorning, reading: null };
    expect(vocabMeaningPrompt(noReading, { isNew: false })).not.toBeNull();
    expect(vocabProductionPrompt(noReading, { isNew: false })).not.toBeNull();
  });

  it("returns null for a gloss that yields no alternatives", () => {
    const qualifierOnly: VocabRowLike = { ...everyMorning, meaning: " (only a qualifier) " };
    expect(vocabMeaningPrompt(qualifierOnly, { isNew: false })).toBeNull();
  });

  it("strips KANJIDIC okurigana markers from kanji readings", () => {
    const row: KanjiRowLike = {
      character: "上",
      onReading: null,
      kunReading: "-うえ,うわ-,あ.げる",
    };
    expect(kanjiReadingPrompt(row, { isNew: false })?.grading).toEqual({
      rule: "normalized_exact",
      alternatives: ["うえ", "うわ", "あげる"],
    });
  });

  it("keeps whichever reading family the row has, and nulls an empty one", () => {
    const onOnly: KanjiRowLike = { character: "丁", onReading: "チョウ,テイ", kunReading: null };
    const kunOnly: KanjiRowLike = { character: "七", onReading: "", kunReading: "なな,なな.つ" };
    expect(kanjiReadingPrompt(onOnly, { isNew: false })?.grading).toEqual({
      rule: "normalized_exact",
      alternatives: ["チョウ", "テイ"],
    });
    expect(kanjiReadingPrompt(kunOnly, { isNew: false })?.grading).toEqual({
      rule: "normalized_exact",
      alternatives: ["なな", "ななつ"],
    });
    const noReadings: KanjiRowLike = { character: "〇", onReading: null, kunReading: null };
    expect(kanjiReadingPrompt(noReadings, { isNew: false })).toBeNull();
  });

  it("throws on an invalid level tag (invariant break, P1.1 style)", () => {
    expect(() => vocabMeaningPrompt({ ...everyMorning, level: "n0" }, { isNew: false })).toThrow(
      /invalid level/,
    );
    expect(() => vocabReadingPrompt({ ...everyMorning, level: "x" }, { isNew: false })).toThrow();
    expect(() => vocabProductionPrompt({ ...everyMorning, level: "" }, { isNew: false })).toThrow();
  });
});

describe("invariants the builder and grader depend on", () => {
  it("always emits ≥1 alternative / must_contain entry (P1.4 notes)", () => {
    for (const prompt of allPrompts) {
      if (prompt.grading.rule === "production") {
        expect(prompt.grading.must_contain.length).toBeGreaterThan(0);
      } else {
        expect(prompt.grading.alternatives.length).toBeGreaterThan(0);
        for (const alternative of prompt.grading.alternatives) {
          expect(alternative.trim()).not.toBe("");
        }
      }
    }
  });

  it("passes is_new through untouched, both ways", () => {
    expect(must(vocabMeaningPrompt(everyMorning, { isNew: true })).is_new).toBe(true);
    expect(meaningPrompt.is_new).toBe(false);
    expect(productionPrompt.is_new).toBe(true);
  });

  it("emits raw (unnormalized) alternatives — P1.4 owns normalization", () => {
    // Katakana on-readings stay katakana; the gloss stays as stored.
    expect(kanjiPrompt.grading).toEqual({
      rule: "normalized_exact",
      alternatives: ["イチ", "イツ", "ひと", "ひとつ"],
    });
    expect(meaningPrompt.grading).toEqual({ rule: "keyword", alternatives: ["every morning"] });
  });

  it("emits specs the P1.4 grader consumes as-is", () => {
    expect(gradeAnswer(meaningPrompt.grading, "every morning").grade).toBe("correct");
    expect(gradeAnswer(readingPrompt.grading, "まいあさ").grade).toBe("correct");
    expect(gradeAnswer(kanjiPrompt.grading, "ひとつ").grade).toBe("correct");
    expect(gradeAnswer(kanjiPrompt.grading, "イチ").grade).toBe("correct");
    expect(gradeAnswer(productionPrompt.grading, "合図を出しました", "solid").grade).toBe("correct");
  });
});

