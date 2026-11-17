// P1.3 — text normalization (Phase-001.md Milestone A): the NFKC/kana
// folding behind LEARNING-DESIGN §2's two grade rules. Pure module — no
// DB, no HTTP. The client sends raw input; everything here runs
// server-side at grading time (§2: "All normalization/grading happens
// server-side"; D7).
//
// Parity: D11 flags JS `String.normalize('NFKC')` semantics versus the
// original Python tooling as the one TypeScript portability risk in this
// product. tests/normalize.test.ts guards it with a hardcoded fixture
// table (literals only, never generated at runtime); the literals and
// the whole pipeline were cross-checked one-off against Python's
// `unicodedata.normalize('NFKC')` at authoring time — see P1.3 Notes in
// Phase-001.md.

/**
 * `normalized exact` rule (§2) — reading/kanji-reading answer path:
 * NFKC → strip whitespace (and invisible format chars) → katakana→hiragana.
 *
 * Kana folding covers U+30A1–U+30F6 only (`ァ…ヶ`, −0x60); the prolonged
 * mark `ー` and the out-of-range `ヷヸヹヺ` / `ヽヾ` are left alone.
 * Punctuation is NOT stripped here — only the `keyword` path strips.
 */
export function normalizeExact(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[\s\p{Cf}]+/gu, "")
    .replace(/[\u30A1-\u30F6]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/**
 * `keyword` rule normalization (§2), in the documented order:
 * lowercase → NFKC → strip punctuation/whitespace, i.e. keep only
 * letters (`\p{L}`) and numbers (`\p{N}`).
 *
 * Deliberately does NOT fold kana — §2 doesn't ask for it and both
 * sides of a keyword comparison pass through this same function, so the
 * comparison stays symmetric (pinned by fixture).
 */
export function normalizeKeyword(input: string): string {
  return input.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Split a stored expected answer (a seed `meaning` gloss) into the
 * normalized keywords the `keyword` rule matches against (§2), so the
 * grader (P1.4) is pure containment in either direction.
 *
 * Pipeline: NFKC-fold → drop balanced `(...)` groups → split on `;`/`,`
 * → `normalizeKeyword` each part → drop empties → dedupe (first-seen
 * order). Parentheticals are dropped *first* (D-7): they are qualifiers
 * on a gloss, not alternate answers — splitting instead would turn
 * `(book, magazine, etc.)` into standalone keywords `book`/`magazine`/
 * `etc`, and cutting on `,` before removing the group would shred it
 * (864 seed rows have a comma inside parens; 1 row nests parens, hence
 * the depth-aware scan). Unbalanced brackets never occur in the seed;
 * for robustness an unclosed `(` swallows the rest of the string and a
 * stray `)` is dropped.
 */
export function expectedKeywords(raw: string): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const part of splitAlternatives(raw)) {
    const keyword = normalizeKeyword(part);
    if (keyword === "" || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
  }
  return keywords;
}

/**
 * §2's split of a stored expected answer into raw (unnormalized)
 * alternatives: drop balanced `(...)` groups first (D-7), then split on
 * `;`/`,`, trim, drop empties — the same pipeline `expectedKeywords`
 * runs, one step short of normalization.
 *
 * The grader (P1.4) consumes these raw parts for its no-space equality
 * path and D-4 token overlap, where the pre-normalization word boundaries
 * must survive (a normalized keyword like `everymorning` has none).
 */
export function splitAlternatives(raw: string): string[] {
  return dropParenGroups(raw.normalize("NFKC"))
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Remove balanced `(...)` groups from `text`, nesting-aware. */
function dropParenGroups(text: string): string {
  let out = "";
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}
