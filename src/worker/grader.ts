// P1.4 — grading rules (Phase-001.md Milestone A): LEARNING-DESIGN §2's
// three Phase-1 rules (`keyword`, `normalized exact`, `production`).
// Pure module — no DB, no HTTP. The client sends raw input; everything
// here runs server-side at grading time (§2: "All normalization/grading
// happens server-side"; UX.md input considerations).
//
// Inputs: raw answer + the stored grading spec (what the prompt carried
// in `sessions.snapshot`, API.md) + the self-grade for production
// prompts. All text processing is delegated to P1.3's normalize module —
// this file owns only the matching/merging logic, so the D11 parity
// fixtures stay in one place (tests/normalize.test.ts).
//
// D-8 (Phase-001.md): the `keyword` rule matches on FULL normalized
// equality or CONTIGUOUS token-sequence containment in either direction —
// not substring containment. Substring matching let short seed keywords
// (`in`, `or`, `new`) grade unrelated answers correct ("thing", "news"),
// which the P1.3 notes flagged as the open risk. Partial token overlap
// with no full match is `shaky` (decision D-4).

import { type Grade, type SelfGrade } from "./keys";
import { normalizeExact, normalizeKeyword, splitAlternatives } from "./normalize";

/** The stored grading spec a prompt is graded against (API.md `grading`). */
export type GradingSpec =
  | { rule: "keyword"; alternatives: string[] }
  | { rule: "normalized_exact"; alternatives: string[] }
  | { rule: "production"; must_contain: string[] };

/** One deterministic production check, surfaced in the UX ✓/✗ line. */
export interface Check {
  value: string;
  passed: boolean;
}

export interface GradeResult {
  grade: Grade;
  /**
   * Raw expected answer for the inline learning moment (§2: recall shows
   * the answer when wrong — `✗ — correct was まいあさ`). For `production`
   * this carries the required tokens; the checks are the display.
   */
  correctAnswer: string;
  /** Present only for `production`: per-token check verdicts (UX.md). */
  checks?: Check[];
}

/**
 * Grade one raw answer against a stored spec. Total on all inputs: an
 * empty answer or an unknown rule (P1.7 validates the wire shape; the
 * grader stays a pure function) grades `incorrect`, never throws.
 * `selfGrade` participates only in the `production` merge (§2); recall
 * prompts never send one.
 */
export function gradeAnswer(
  spec: GradingSpec,
  rawAnswer: string,
  selfGrade: SelfGrade | null = null,
): GradeResult {
  switch (spec.rule) {
    case "keyword":
      return gradeKeyword(spec.alternatives, rawAnswer);
    case "normalized_exact":
      return gradeExact(spec.alternatives, rawAnswer);
    case "production":
      return gradeProduction(spec.must_contain, rawAnswer, selfGrade);
    default:
      return { grade: "incorrect", correctAnswer: "" };
  }
}

// ─── keyword (recall/meaning, §2 + D-8) ────────────────────────────

function gradeKeyword(alternatives: string[], rawAnswer: string): GradeResult {
  const correctAnswer = alternatives.join("; ");
  const answerNorm = normalizeKeyword(rawAnswer);
  const answerTokens = tokenize(rawAnswer);
  if (answerNorm === "") {
    return { grade: "incorrect", correctAnswer };
  }

  const expectedTokens = new Set<string>();
  for (const alternative of alternatives) {
    for (const part of splitAlternatives(alternative)) {
      // Full normalized equality — recovers space-less answers
      // ("everymorning") that token matching alone would miss (D-8).
      if (answerNorm === normalizeKeyword(part)) {
        return { grade: "correct", correctAnswer };
      }
      // Contiguous token-sequence containment, either direction
      // ("morning" ⊂ "every morning" and vice versa — §2's "or vice
      // versa", with real word boundaries).
      const partTokens = tokenize(part);
      if (
        containsSequence(answerTokens, partTokens) ||
        containsSequence(partTokens, answerTokens)
      ) {
        return { grade: "correct", correctAnswer };
      }
      for (const token of partTokens) expectedTokens.add(token);
    }
  }

  // D-4: some tokens hit but no full match → shaky, not incorrect.
  if (answerTokens.some((token) => expectedTokens.has(token))) {
    return { grade: "shaky", correctAnswer };
  }
  return { grade: "incorrect", correctAnswer };
}

// ─── normalized exact (recall/reading, kanji_reading, §2) ──────────

function gradeExact(alternatives: string[], rawAnswer: string): GradeResult {
  const correctAnswer = alternatives.join("; ");
  const answer = normalizeExact(rawAnswer);
  if (answer === "") {
    return { grade: "incorrect", correctAnswer };
  }
  const hit = alternatives.some((alternative) => normalizeExact(alternative) === answer);
  return { grade: hit ? "correct" : "incorrect", correctAnswer };
}

// ─── production (§2 merge matrix) ──────────────────────────────────

function gradeProduction(
  mustContain: string[],
  rawAnswer: string,
  selfGrade: SelfGrade | null,
): GradeResult {
  const correctAnswer = mustContain.join("; ");
  const answer = normalizeExact(rawAnswer);
  const checks: Check[] = mustContain.map((value) => ({
    value,
    passed: normalizeExact(value) !== "" && answer.includes(normalizeExact(value)),
  }));
  const checksPass = checks.every((check) => check.passed);

  // Merge matrix (§2): checks fail OR self-grade `wrong` → incorrect;
  // pass + solid → correct; pass + shaky → shaky. A missing self-grade
  // with passing checks grades shaky — never credit `correct` without
  // the user's verdict (P1.7's schema requires the field anyway).
  let grade: Grade;
  if (!checksPass || selfGrade === "wrong") {
    grade = "incorrect";
  } else if (selfGrade === "solid") {
    grade = "correct";
  } else {
    grade = "shaky";
  }
  return { grade, correctAnswer, checks };
}

// ─── helpers ───────────────────────────────────────────────────────

/**
 * Token view used by the `keyword` rule (D-8 / D-4): lowercase → NFKC →
 * split on everything that isn't a letter or digit — same char class as
 * `normalizeKeyword`, but keeping the word boundaries that containment
 * and overlap need.
 */
function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/** True when `needle` occurs contiguously inside `haystack`. */
function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}
