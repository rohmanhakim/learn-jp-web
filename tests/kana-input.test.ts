// P1.5.3 — kana-input: a hardcoded behavior fixture table (input→expected
// literals, NEVER generated at runtime) pinning wanakana@5.3.1's
// conversion under OUR options — the upgrade-safety role D11's parity
// table plays for normalization: an upgrade can never silently change
// what grades. Expected values were captured from ONE real run of the
// library at authoring time (2026-11-20) and hardcoded verbatim;
// surprising-but-real outputs are pinned deliberately and commented,
// per Phase-001.5.md ("assert the actual pinned behavior").
//
// Plus D-2's scoping-predicate tests over the REAL prompt factories
// from src/worker/prompts.ts, with an exhaustiveness guard so a future
// grading rule is a deliberate classification, not an accident.
//
// Environment caveat (Phase-001.5.md): tests run inside workerd — this
// file imports wanakana's pure `toKana` path (no DOM at module scope;
// `window` is only touched inside the composition handler, which these
// tests never call). Importing it here IS the caveat's verification.
import { describe, expect, it } from "vitest";
import { toKana } from "wanakana";
import { KANA_INPUT_OPTIONS, isKanaAnswerPrompt } from "../src/client/kana-input";
import { type GradingSpec } from "../src/worker/grader";
import {
  type KanjiRowLike,
  type Prompt,
  type VocabRowLike,
  kanjiReadingPrompt,
  vocabMeaningPrompt,
  vocabProductionPrompt,
  vocabReadingPrompt,
} from "../src/worker/prompts";

// ─── behavior fixtures (hardcoded literals; one real run at authoring) ───

/** [input, expected] through `toKana(input, KANA_INPUT_OPTIONS)`. */
const ROMAJI_FIXTURES: ReadonlyArray<readonly [string, string]> = [
  // Hepburn + kunrei variants agree on the same kana
  ["shi", "し"],
  ["si", "し"],
  ["chi", "ち"],
  ["ti", "ち"],
  ["tsu", "つ"],
  ["tu", "つ"],
  ["fu", "ふ"],
  ["hu", "ふ"],
  // sokuon
  ["matte", "まって"],
  ["tte", "って"],
  // ん: explicit forms and mid-word n before a consonant
  ["nn", "ん"],
  ["n'", "ん"],
  ["nihonn", "にほん"], // double-n commits a final ん
  ["denwa", "でんわ"], // mid-word n before w → ん
  // PINNED QUIRK — trailing n stays pending under IMEMode (bind() FORCES
  // `options.IMEMode || true`, so no options avoid this): a final n could
  // still become な/に/… and is only committed by a following character —
  // SPACEBAR in the browser (verified: "nihon " → にほん, space consumed),
  // or double-n. The plan's illustrative `shimbun → しんぶん` does NOT
  // hold: wanakana does no m-assimilation (type `shinbun` instead) and
  // the pending m stays raw too.
  ["nihon", "にほn"],
  ["nen", "ねn"],
  ["shinbun", "しんぶn"],
  ["shimbun", "しmぶn"],
  // Space-commit semantics (what the spacebar workaround relies on):
  // a non-continuation char commits the pending n AND is consumed;
  // with nothing pending the space simply remains (harmless — the
  // server's normalizeExact strips every whitespace kind).
  ["nihon ", "にほん"],
  ["nen ", "ねん"],
  ["maiasa ", "まいあさ "],
  // small kana (x/l prefix and blended vowels)
  ["xtsu", "っ"],
  ["ltsu", "っ"],
  ["kya", "きゃ"],
  // long vowels
  ["toukyou", "とうきょう"],
  ["ou", "おう"],
  ["gou", "ごう"],
  // uppercase under IMEMode: 'toHiragana' → hiragana (D-3: the library
  // default would emit katakana here)
  ["MAIASA", "まいあさ"],
  ["go", "ご"],
  // identity and pass-through — PINNED QUIRK: `café` is NOT pass-through
  // as the plan assumed (ca→か, fe→ふぇ); harmless because bound fields
  // only ever take kana answers, but pinned so an upgrade can't shift it.
  ["こんにちは", "こんにちは"],
  ["2026", "2026"],
  ["café", "かfé"],
];

describe("toKana(input, KANA_INPUT_OPTIONS) — behavior fixtures (D11-style pin)", () => {
  for (const [input, expected] of ROMAJI_FIXTURES) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(toKana(input, KANA_INPUT_OPTIONS)).toBe(expected);
    });
  }
});

describe("KANA_INPUT_OPTIONS (D-3 pin)", () => {
  it("is exactly { IMEMode: 'toHiragana' }", () => {
    expect(KANA_INPUT_OPTIONS).toEqual({ IMEMode: "toHiragana" });
  });
});

// ─── scoping predicate over the REAL prompt factories (D-2) ───

// Real seed rows (data/seed/*.json), same grounding as tests/prompts.test.ts.
const everyMorning: VocabRowLike = {
  content: "毎朝",
  reading: "まいあさ",
  meaning: "every morning",
  level: "n5",
};
const ichi: KanjiRowLike = {
  character: "一",
  onReading: "イチ,イツ",
  kunReading: "ひと-,ひと.つ",
};

/** `Prompt | null` guard for the always-present fixtures. */
function must(prompt: Prompt | null): Prompt {
  if (prompt === null) throw new Error("expected a prompt");
  return prompt;
}

const readingPrompt = must(vocabReadingPrompt(everyMorning, { isNew: false }));
const kanjiPrompt = must(kanjiReadingPrompt(ichi, { isNew: false }));
const meaningPrompt = must(vocabMeaningPrompt(everyMorning, { isNew: false }));
const productionPrompt = must(vocabProductionPrompt(everyMorning, { isNew: false }));

describe("isKanaAnswerPrompt — scoping (D-2, real prompt factories)", () => {
  it("binds the vocab reading prompt (normalized_exact)", () => {
    expect(readingPrompt.grading.rule).toBe("normalized_exact");
    expect(isKanaAnswerPrompt(readingPrompt)).toBe(true);
  });

  it("binds the kanji reading prompt (normalized_exact)", () => {
    expect(kanjiPrompt.grading.rule).toBe("normalized_exact");
    expect(isKanaAnswerPrompt(kanjiPrompt)).toBe(true);
  });

  it("never binds the meaning prompt (keyword — English answers stay English)", () => {
    expect(meaningPrompt.grading.rule).toBe("keyword");
    expect(isKanaAnswerPrompt(meaningPrompt)).toBe(false);
  });

  it("never binds the production prompt (production textareas stay untouched)", () => {
    expect(productionPrompt.grading.rule).toBe("production");
    expect(isKanaAnswerPrompt(productionPrompt)).toBe(false);
  });

  it("classifies EVERY current grading rule deliberately (exhaustiveness guard)", () => {
    // Record<GradingSpec["rule"], …> is exhaustive at compile time: a new
    // rule fails `tsc` until someone classifies it here — "a deliberate
    // decision, not an accident".
    const expected: Record<GradingSpec["rule"], boolean> = {
      keyword: false,
      normalized_exact: true,
      production: false,
    };
    for (const [rule, shouldBind] of Object.entries(expected)) {
      expect(isKanaAnswerPrompt({ grading: { rule } }), `rule: ${rule}`).toBe(shouldBind);
    }
  });

  it("never binds a prompt without a grading spec (API.md's passage prompt shape)", () => {
    expect(isKanaAnswerPrompt({})).toBe(false);
    expect(isKanaAnswerPrompt({ grading: undefined })).toBe(false);
  });
});