// P1.5 — prompt factory (Phase-001.md Milestone B): one content row →
// one API.md prompt object, exactly in the session-snapshot shape.
// Pure module — no DB, no HTTP: rows arrive as plain structural input
// (the builder passes Drizzle rows straight in; shapes mirror the
// schema's column names) and every prompt comes back as a plain object
// the snapshot serializer can store verbatim (DATA-MODEL: "sessions
// snapshot keeps exactly what was served").
//
// Keys come from P1.1's builders, so the builder (P1.6) and
// /api/responses (P1.10) agree on prompt_key ↔ item_key through
// itemKeyFromPromptKey — the golden tests round-trip every key this
// file emits.
//
// Grading specs are RAW (P1.4 owns all normalization): meaning
// alternatives are the gloss split on `;`/`,` with parentheticals
// dropped (D-7, via splitAlternatives), readings stay exactly as
// stored (katakana on-readings included — normalizeExact folds them at
// grade time). Every spec carries ≥1 entry: an empty `production`
// must_contain grades vacuous-pass (P1.4) and this file is the only
// producer of that spec.
//
// Failure style: `null` means "this row cannot produce this prompt"
// (a missing/blank reading — 2 seed rows) and the builder skips it;
// an invalid `level` tag is an invariant break (seed validation
// guarantees n5..n1) and throws, matching P1.1's builders.

import { type GradingSpec } from "./grader";
import {
  type Bucket,
  type Level,
  type PromptKind,
  isLevel,
  kanjiPromptKey,
  productionPromptKey,
  recallPromptKey,
} from "./keys";
import { splitAlternatives } from "./normalize";

/**
 * The `input` control the session screen renders for a prompt
 * (API.md). `choice` belongs to passage questions (Phase 3) and is
 * declared now so P1.7's schema and this file agree on one enum.
 * `text+selfgrade` is authoritative (D-9): the worked example
 * overrules API.md's stale `selfgrade+text` comment, which the same
 * change amends.
 */
export const PROMPT_INPUTS = ["text", "text+selfgrade", "choice"] as const;
export type PromptInput = (typeof PROMPT_INPUTS)[number];

/** One prompt exactly as it appears in `sessions.snapshot` (API.md). */
export interface Prompt {
  prompt_key: string;
  kind: PromptKind;
  bucket: Bucket;
  is_new: boolean;
  instruction: string;
  stimulus: string;
  input: PromptInput;
  grading: GradingSpec;
}

/** Caller-controlled flags — a prompt never infers its own recency. */
export interface PromptOptions {
  /** Mirrors the wire field `is_new`: true when drawn as a new item. */
  isNew: boolean;
}

/** The vocabulary columns a prompt is built from (Drizzle row shape). */
export interface VocabRowLike {
  content: string;
  reading: string | null;
  meaning: string;
  level: string;
}

/** The kanji columns a prompt is built from (Drizzle row shape). */
export interface KanjiRowLike {
  character: string;
  onReading: string | null;
  kunReading: string | null;
}

/**
 * `vocab:…:meaning` direction: JP surface → type the EN meaning (§2).
 * `keyword` alternatives are the raw gloss split (D-7) — the grader
 * normalizes both sides itself.
 */
export function vocabMeaningPrompt(
  row: VocabRowLike,
  options: PromptOptions,
): Prompt | null {
  const alternatives = splitAlternatives(row.meaning);
  if (alternatives.length === 0) return null; // empty/paren-only gloss
  return {
    prompt_key: recallPromptKey(asLevel(row.level), row.content, "meaning"),
    kind: "recall",
    bucket: "vocab_recog",
    is_new: options.isNew,
    instruction: "Type the meaning",
    stimulus: row.content,
    input: "text",
    grading: { rule: "keyword", alternatives },
  };
}

/**
 * `vocab:…:reading` direction: EN meaning → type the kana reading.
 * The cue is §2's primary wording ("EN meaning → type kana", D-10) and
 * is emitted VERBATIM — a cue is display text, so no processing here;
 * the grading path splits the gloss itself. `null` when the row has no
 * reading (2 seed rows do not).
 */
export function vocabReadingPrompt(
  row: VocabRowLike,
  options: PromptOptions,
): Prompt | null {
  const reading = row.reading?.trim() ?? "";
  if (reading === "") return null;
  return {
    prompt_key: recallPromptKey(asLevel(row.level), row.content, "reading"),
    kind: "recall",
    bucket: "vocab_recog",
    is_new: options.isNew,
    instruction: "Type the reading",
    stimulus: row.meaning,
    input: "text",
    grading: { rule: "normalized_exact", alternatives: [reading] },
  };
}

/**
 * `kanji:一:onkun` direction (§2's `kanji_reading` row; the wire `kind`
 * is `recall` — kanji prompts are typed recall over a `r:kanji:` key).
 *
 * Stimulus is the bare character (D-10): a `kanji` row carries no word
 * context, and the item key is character-scoped, so alternatives are
 * the character's full on + kun set — i.e. either family is accepted,
 * §2's "accept on or kun" without a word to narrow it. KANJIDIC
 * okurigana markers (`.` separator, `-` prefix) are stripped so the
 * alternatives are typeable answers (`ひと.つ` → `ひとつ`,
 * `-うえ` → `うえ`); the seed's readings contain only kana plus those
 * two markers. `null` when neither family is present (0 seed rows).
 */
export function kanjiReadingPrompt(
  row: KanjiRowLike,
  options: PromptOptions,
): Prompt | null {
  const alternatives = kanjiAlternatives(row.onReading, row.kunReading);
  if (alternatives.length === 0) return null;
  return {
    prompt_key: kanjiPromptKey(row.character),
    kind: "recall",
    bucket: "kanji",
    is_new: options.isNew,
    instruction: "Type a reading (on or kun)",
    stimulus: row.character,
    input: "text",
    grading: { rule: "normalized_exact", alternatives },
  };
}

/**
 * `vocab:…:produce` direction: use the word in a sentence (§2
 * production). `must_contain` is the surface itself (Phase-001 P1.5
 * bullet), and the stimulus carries the surface plus the gloss's first
 * alternative (`合図 (sign)`, D-11); a gloss with no alternatives
 * yields the bare surface.
 */
export function vocabProductionPrompt(
  row: VocabRowLike,
  options: PromptOptions,
): Prompt | null {
  const promptKey = productionPromptKey(asLevel(row.level), row.content);
  const firstAlternative = splitAlternatives(row.meaning)[0];
  return {
    prompt_key: promptKey,
    kind: "production",
    bucket: "writing",
    is_new: options.isNew,
    instruction: `Write a sentence using ${row.content}`,
    stimulus:
      firstAlternative === undefined
        ? row.content
        : `${row.content} (${firstAlternative})`,
    input: "text+selfgrade",
    grading: { rule: "production", must_contain: [row.content] },
  };
}

// ─── helpers ───────────────────────────────────────────────────────

/** Seed validation guarantees n5..n1; anything else is an invariant break. */
function asLevel(level: string): Level {
  if (!isLevel(level)) throw new Error(`invalid level tag: ${level}`);
  return level;
}

/**
 * on + kun readings → deduped typeable alternatives, comma-split in
 * stored order, okurigana markers removed.
 */
function kanjiAlternatives(on: string | null, kun: string | null): string[] {
  const alternatives: string[] = [];
  const seen = new Set<string>();
  for (const family of [on, kun]) {
    if (family === null) continue;
    for (const part of family.split(",")) {
      const reading = part.trim().replace(/[.-]/g, "");
      if (reading === "" || seen.has(reading)) continue;
      seen.add(reading);
      alternatives.push(reading);
    }
  }
  return alternatives;
}

