// P1.1 — shared domain types + item-key / prompt-key helpers.
//
// Pure module (Phase-001.md Milestone A): no DB, no HTTP — every later
// module (srs, grader, prompts, builder, endpoints) pulls its types from
// here. Key formats come from DATA-MODEL.md §Item keying (item_key) and
// API.md session-snapshot examples (prompt_key).
//
// Error style: builders take trusted, typed input and throw on invalid
// segments; parsers handle untrusted (API-supplied) strings and return
// null on any malformed key.

// ─── shared enums ─────────────────────────────────────────────────

/** JLPT difficulty tags — order content difficulty only (DECISIONS.md D4). */
export const LEVELS = ["n5", "n4", "n3", "n2", "n1"] as const;
export type Level = (typeof LEVELS)[number];

/** Grade assigned to a graded response (LEARNING-DESIGN §1). */
export const GRADES = ["correct", "shaky", "incorrect"] as const;
export type Grade = (typeof GRADES)[number];

/** User's verdict on their own production answer (LEARNING-DESIGN §2). */
export const SELF_GRADES = ["solid", "shaky", "wrong"] as const;
export type SelfGrade = (typeof SELF_GRADES)[number];

/** Skill buckets driving composition and weakness display (§3). */
export const BUCKETS = ["vocab_recog", "kanji", "reading", "writing"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** Wire-level `kind` field on a prompt in the session snapshot (API.md). */
export const PROMPT_KINDS = ["recall", "production", "passage_question", "writing"] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

/** Directions a vocabulary item is practiced in (DATA-MODEL §Item keying). */
export const VOCAB_DIRECTIONS = ["meaning", "reading", "produce"] as const;
export type VocabDirection = (typeof VOCAB_DIRECTIONS)[number];

/** Recall prompts ask for meaning or reading, never a production (§2). */
export type RecallDirection = Extract<VocabDirection, "meaning" | "reading">;

/** Runtime guards for untrusted enum strings (e.g. API request bodies). */
export function isLevel(value: string): value is Level {
  return (LEVELS as readonly string[]).includes(value);
}
export function isGrade(value: string): value is Grade {
  return (GRADES as readonly string[]).includes(value);
}
export function isSelfGrade(value: string): value is SelfGrade {
  return (SELF_GRADES as readonly string[]).includes(value);
}
export function isBucket(value: string): value is Bucket {
  return (BUCKETS as readonly string[]).includes(value);
}
export function isPromptKind(value: string): value is PromptKind {
  return (PROMPT_KINDS as readonly string[]).includes(value);
}
export function isVocabDirection(value: string): value is VocabDirection {
  return (VOCAB_DIRECTIONS as readonly string[]).includes(value);
}

// ─── parsed key shapes ────────────────────────────────────────────

export type ItemKey =
  | { kind: "vocab"; level: Level; surface: string; direction: VocabDirection }
  | { kind: "kanji"; character: string; direction: "onkun" }
  | { kind: "passage"; level: Level; slug: string; ordinal: number }
  | { kind: "writing"; level: Level; slug: string };

export type ParsedPromptKey =
  | { kind: "recall"; scope: "vocab"; level: Level; surface: string; direction: RecallDirection }
  | { kind: "recall"; scope: "kanji"; character: string; direction: "onkun" }
  | { kind: "production"; level: Level; surface: string }
  | { kind: "writing"; level: Level; slug: string }
  | { kind: "passage_question"; level: Level; slug: string; ordinal: number }
  | { kind: "capture"; level: Level; slug: string };

// ─── builders (trusted input; throw on invalid segments) ──────────

function assertSegment(label: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.includes(":")) {
    throw new Error(`${label} must not contain ":"`);
  }
}

function assertOrdinal(ordinal: number): void {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error(`ordinal must be a positive integer, got ${ordinal}`);
  }
}

/** `vocab:jlpt:n5:毎朝:meaning` (DATA-MODEL §Item keying). */
export function vocabItemKey(level: Level, surface: string, direction: VocabDirection): string {
  assertSegment("surface", surface);
  return `vocab:jlpt:${level}:${surface}:${direction}`;
}

/** `kanji:一:onkun` — kanji are practiced reading-only. */
export function kanjiItemKey(character: string): string {
  assertSegment("character", character);
  return `kanji:${character}:onkun`;
}

/** `passage:n4:park:q2` — usually not SRS-scheduled (LEARNING-DESIGN §1). */
export function passageItemKey(level: Level, slug: string, ordinal: number): string {
  assertSegment("slug", slug);
  assertOrdinal(ordinal);
  return `passage:${level}:${slug}:q${ordinal}`;
}

/** `writing:n3:school-day` — prompted short writing. */
export function writingItemKey(level: Level, slug: string): string {
  assertSegment("slug", slug);
  return `writing:${level}:${slug}`;
}

/** `r:jlpt:n5:毎朝:meaning` — recall prompt over a vocabulary item. */
export function recallPromptKey(level: Level, surface: string, direction: RecallDirection): string {
  assertSegment("surface", surface);
  return `r:jlpt:${level}:${surface}:${direction}`;
}

/** `w:jlpt:n3:合図:produce` — vocabulary production prompt. */
export function productionPromptKey(level: Level, surface: string): string {
  assertSegment("surface", surface);
  return `w:jlpt:${level}:${surface}:produce`;
}

/** `r:kanji:一:onkun` — kanji reading prompt (shape settled in P1.1 Notes). */
export function kanjiPromptKey(character: string): string {
  assertSegment("character", character);
  return `r:kanji:${character}:onkun`;
}

/** `p:n4:park-quiet:q1` — passage comprehension question. */
export function passagePromptKey(level: Level, slug: string, ordinal: number): string {
  assertSegment("slug", slug);
  assertOrdinal(ordinal);
  return `p:${level}:${slug}:q${ordinal}`;
}

/** `capture:n4:park-quiet` — unknown-word capture during reading (§8). */
export function capturePromptKey(level: Level, slug: string): string {
  assertSegment("slug", slug);
  return `capture:${level}:${slug}`;
}

/** `w:n3:school-day` — writing-bank prompt (shape settled in P1.1 Notes). */
export function writingPromptKey(level: Level, slug: string): string {
  assertSegment("slug", slug);
  return `w:${level}:${slug}`;
}

// ─── parsers (untrusted input; null on malformed keys) ────────────

/** `q1` → 1; anything else (missing `q`, zero, non-numeric) → null. */
function parseOrdinal(segment: string): number | null {
  const match = /^q([1-9][0-9]*)$/.exec(segment);
  const digits = match?.[1];
  if (digits === undefined) return null;
  const ordinal = Number(digits);
  return Number.isSafeInteger(ordinal) ? ordinal : null;
}

export function parseItemKey(key: string): ItemKey | null {
  const parts = key.split(":");
  switch (parts[0]) {
    case "vocab": {
      // vocab:jlpt:<level>:<surface>:<direction> — exactly 5 segments.
      if (parts.length !== 5 || parts[1] !== "jlpt") return null;
      const [, , level, surface, direction] = parts;
      if (!level || !surface || !direction) return null;
      if (!isLevel(level) || !isVocabDirection(direction)) return null;
      return { kind: "vocab", level, surface, direction };
    }
    case "kanji": {
      if (parts.length !== 3) return null;
      const [, character, direction] = parts;
      if (!character || direction !== "onkun") return null;
      return { kind: "kanji", character, direction: "onkun" };
    }
    case "passage": {
      if (parts.length !== 4) return null;
      const [, level, slug, q] = parts;
      if (!level || !slug || !q || !isLevel(level)) return null;
      const ordinal = parseOrdinal(q);
      if (ordinal === null) return null;
      return { kind: "passage", level, slug, ordinal };
    }
    case "writing": {
      if (parts.length !== 3) return null;
      const [, level, slug] = parts;
      if (!level || !slug || !isLevel(level)) return null;
      return { kind: "writing", level, slug };
    }
    default:
      return null;
  }
}

export function parsePromptKey(key: string): ParsedPromptKey | null {
  const parts = key.split(":");
  switch (parts[0]) {
    case "r": {
      if (parts[1] === "jlpt") {
        // r:jlpt:<level>:<surface>:<meaning|reading>
        if (parts.length !== 5) return null;
        const [, , level, surface, direction] = parts;
        if (!level || !surface || !direction) return null;
        if (!isLevel(level)) return null;
        if (direction !== "meaning" && direction !== "reading") return null;
        return { kind: "recall", scope: "vocab", level, surface, direction };
      }
      if (parts[1] === "kanji") {
        // r:kanji:<character>:onkun
        if (parts.length !== 4 || parts[3] !== "onkun") return null;
        const character = parts[2];
        if (!character) return null;
        return { kind: "recall", scope: "kanji", character, direction: "onkun" };
      }
      return null;
    }
    case "w": {
      if (parts[1] === "jlpt") {
        // w:jlpt:<level>:<surface>:produce
        if (parts.length !== 5 || parts[4] !== "produce") return null;
        const [, , level, surface] = parts;
        if (!level || !surface || !isLevel(level)) return null;
        return { kind: "production", level, surface };
      }
      // w:<level>:<slug> — writing-bank prompt; segment 2 is an n* level,
      // never `jlpt`, so it cannot collide with the production form above.
      if (parts.length !== 3) return null;
      const [, level, slug] = parts;
      if (!level || !slug || !isLevel(level)) return null;
      return { kind: "writing", level, slug };
    }
    case "p": {
      if (parts.length !== 4) return null;
      const [, level, slug, q] = parts;
      if (!level || !slug || !q || !isLevel(level)) return null;
      const ordinal = parseOrdinal(q);
      if (ordinal === null) return null;
      return { kind: "passage_question", level, slug, ordinal };
    }
    case "capture": {
      if (parts.length !== 3) return null;
      const [, level, slug] = parts;
      if (!level || !slug || !isLevel(level)) return null;
      return { kind: "capture", level, slug };
    }
    default:
      return null;
  }
}

/**
 * The SRS identity a prompt grades against, or null when the prompt has
 * no item key (capture rows live in `unknown_words` until queued — D-5).
 * Single source of truth so the builder and `/api/responses` (P1.10)
 * agree on identity.
 */
export function itemKeyFromPromptKey(promptKey: string): string | null {
  const parsed = parsePromptKey(promptKey);
  if (parsed === null) return null;
  switch (parsed.kind) {
    case "recall":
      return parsed.scope === "vocab"
        ? vocabItemKey(parsed.level, parsed.surface, parsed.direction)
        : kanjiItemKey(parsed.character);
    case "production":
      return vocabItemKey(parsed.level, parsed.surface, "produce");
    case "writing":
      return writingItemKey(parsed.level, parsed.slug);
    case "passage_question":
      return passageItemKey(parsed.level, parsed.slug, parsed.ordinal);
    case "capture":
      return null;
  }
}