// P1.3 — normalization: a hardcoded parity fixture table (input→expected
// literals, NEVER generated at runtime) guarding D11's one TS
// portability risk (JS NFKC semantics vs the original Python tooling),
// plus keyword-splitting cases drawn from real seed glosses — including
// D-7's parenthetical rule (`toy` must not become an answer for 風車).
import { describe, expect, it } from "vitest";
import vocabRaw from "../data/seed/vocabulary.json?raw";
import { expectedKeywords, normalizeExact, normalizeKeyword } from "../src/worker/normalize";

// ─── parity fixtures (hardcoded literals; cross-checked once against
// Python's unicodedata.normalize('NFKC') at authoring time — D11) ────

/** [input, expected] for the `normalized exact` reading path. */
const EXACT_FIXTURES: ReadonlyArray<readonly [string, string]> = [
  // identity / kana
  ["かきとり", "かきとり"],
  ["カキトリ", "かきとり"],
  ["かきカナとり", "かきかなとり"],
  ["カー", "かー"], // prolonged sound mark survives
  // halfwidth katakana: NFKC folds width and composes voiced forms
  ["ｶｷﾄﾘ", "かきとり"],
  ["ﾊﾟ", "ぱ"],
  ["ｳﾞ", "ゔ"],
  ["｢ｶﾞｰ｣", "「がー」"], // brackets fold to fullwidth but are NOT stripped
  // fullwidth ASCII folds to halfwidth; exact does not lowercase
  ["ＡＢＣ１２３", "ABC123"],
  // whitespace: every kind disappears
  ["かき とり", "かきとり"],
  ["かき\u3000とり", "かきとり"], // ideographic space → NFKC → stripped
  ["かき\tとり\n", "かきとり"],
  ["  かき  ", "かき"],
  ["か\u00A0き", "かき"], // NBSP → NFKC → stripped
  ["か\u200Bき", "かき"], // zero-width space (format char) stripped
  // NFKC composes kana + voicing marks before folding
  ["か\u3099", "が"],
  ["は\u309A", "ぱ"],
  // edges
  ["", ""],
  ["ー", "ー"], // U+30FC is shared, not in the kana fold range
  ["ヷ", "ヷ"], // U+30F7 is outside U+30A1–U+30F6
];

/** [input, expected] for the `keyword` meaning path. */
const KEYWORD_FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ["every morning", "everymorning"],
  ["Every Morning!", "everymorning"],
  ["  every   morning  ", "everymorning"],
  ["well-timed", "welltimed"], // hyphen stripped
  ["it's", "its"], // apostrophe stripped
  ["U.S.A.", "usa"], // periods stripped
  ["type-2 diabetes", "type2diabetes"],
  ["round-trip – dash", "roundtripdash"], // en dash (U+2013) stripped
  ["etc.", "etc"],
  ["ＡＢＣ", "abc"], // lowercase runs BEFORE NFKC (§2 order)
  ["１２３", "123"],
  ["（３）", "3"], // fullwidth parens/digit fold, then strip
  ["・、。「」！", ""], // kana punctuation all stripped
  ["ﬁnance", "finance"], // ligature folds under NFKC
  ["e\u0300", "è"], // combining accent composes under NFKC
  ["È", "è"],
  [" è", "è"], // non-ASCII letters kept (\p{L})
  ["圓", "圓"], // CJK kept (\p{L})
  ["カナ", "カナ"], // keyword path has NO kana folding (§2) — unlike exact
  ["", ""],
];

describe("normalizeExact — parity fixtures (D11, hardcoded literals)", () => {
  for (const [input, expected] of EXACT_FIXTURES) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeExact(input)).toBe(expected);
    });
  }

  it("is idempotent", () => {
    for (const [input] of EXACT_FIXTURES) {
      expect(normalizeExact(normalizeExact(input))).toBe(normalizeExact(input));
    }
  });
});

describe("normalizeKeyword — parity fixtures (D11, hardcoded literals)", () => {
  for (const [input, expected] of KEYWORD_FIXTURES) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeKeyword(input)).toBe(expected);
    });
  }

  it("is idempotent", () => {
    for (const [input] of KEYWORD_FIXTURES) {
      expect(normalizeKeyword(normalizeKeyword(input))).toBe(normalizeKeyword(input));
    }
  });
});

describe("expectedKeywords — §2 split on ; , with D-7 parentheticals", () => {
  it("splits alternatives and normalizes each", () => {
    expect(expectedKeywords("same feeling; same sentiment")).toEqual([
      "samefeeling",
      "samesentiment",
    ]);
  });

  it("drops parenthetical groups before splitting (D-7)", () => {
    // Real seed gloss (風車): `toy` must NOT become an answer keyword.
    expect(
      expectedKeywords(
        "windmill; wind turbine; pinwheel (toy); windmill (toy); Clematis patens (species of climbing plant)",
      ),
    ).toEqual(["windmill", "windturbine", "pinwheel", "clematispatens"]);
  });

  it("never yields qualifier fragments as keywords (comma inside parens)", () => {
    expect(
      expectedKeywords(
        "buying and reading (book, magazine, etc.); subscribing (incl. free subscriptions)",
      ),
    ).toEqual(["buyingandreading", "subscribing"]);
  });

  it("handles nested parens (the one seed row that nests)", () => {
    expect(
      expectedKeywords("dog (Canis (lupus) familiaris); canine; squealer; rat; loser"),
    ).toEqual(["dog", "canine", "squealer", "rat", "loser"]);
  });

  it("dedupes after normalization", () => {
    expect(expectedKeywords("windmill; Windmill; WINDMILL")).toEqual(["windmill"]);
  });

  it("drops empty segments and trims the edges", () => {
    expect(expectedKeywords("a;;b,;,").sort()).toEqual(["a", "b"]);
    expect(expectedKeywords("bet; wager;")).toEqual(["bet", "wager"]);
    expect(expectedKeywords("")).toEqual([]);
    expect(expectedKeywords("(only)")).toEqual([]);
  });

  it("keeps letters/numbers from every script", () => {
    expect(expectedKeywords("圓; old yen")).toEqual(["圓", "oldyen"]);
  });

  it("tolerates unbalanced brackets without throwing (absent from seed)", () => {
    expect(expectedKeywords("a) b")).toEqual(["ab"]); // stray `)` dropped
    expect(expectedKeywords("a (b")).toEqual(["a"]); // unclosed `(` swallows rest
  });
});

describe("seed glosses (all 8,334 real meanings)", () => {
  const rows = JSON.parse(vocabRaw) as Array<{ meaning: string }>;

  it("every meaning yields at least one keyword", () => {
    const empty = rows
      .map((r) => r.meaning)
      .filter((meaning) => expectedKeywords(meaning).length === 0);
    expect(empty.slice(0, 5)).toEqual([]);
  });

  it("every keyword is letters/digits only — punctuation fully stripped", () => {
    const bad = rows
      .flatMap((r) => expectedKeywords(r.meaning))
      .filter((keyword) => !/^[\p{L}\p{N}]+$/u.test(keyword));
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

