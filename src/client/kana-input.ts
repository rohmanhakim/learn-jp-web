// P1.5.2 — romaji→kana conversion layer for kana-answer prompts
// (Phase-001.5.md): a client-only input aid so `recall/reading` and
// `kanji_reading` prompts can be answered on a device without a
// Japanese IME. Transliteration only — no candidate list, no
// dictionary, no toggle (D-1 / DECISIONS D14); this module is keyboard
// mechanics and never grades, schedules, or selects content
// (ARCHITECTURE: the client contains no learning logic).
//
// Library facts verified against wanakana@5.3.1's source
// (esm/index.js), not assumed:
//   • bind() is self-idempotent — it returns early when the element
//     already carries `data-wanakana-id`, so re-binding cannot leak a
//     second listener;
//   • unbind() THROWS when no listener is registered, hence the
//     `data-wanakana-id` guard in unbindKanaInput before calling it;
//   • the library's input handler has NO `isComposing` check and only
//     skips conversion while `dataset.ignoreComposition === "true"` —
//     a value its own composition handler maintains on macOS ONLY — so
//     composition safety is ours (D-4): our compositionstart/end
//     handlers below drive that attribute on every platform. Order on
//     compositionend: library handler → ours (resets the attribute) →
//     the caller's sync listener (Session.svelte), by attachment.
//
// Zero network: the library ships in the bundle; conversion is pure
// string work (P1.5.4 asserts no requests while typing, offline-safe).

import { bind, unbind } from "wanakana";

/** The library exports no options type — derive it from bind(). */
type BindOptions = NonNullable<Parameters<typeof bind>[1]>;

/**
 * D-3: `IMEMode: "toHiragana"` — hiragana output matches the
 * instruction "Type the reading" and lands inside normalizeExact's
 * katakana→hiragana fold by construction (the library default would
 * emit katakana when Shift is tapped by accident).
 */
export const KANA_INPUT_OPTIONS: BindOptions = { IMEMode: "toHiragana" };

/**
 * The prompt shape this layer scopes on — structural on purpose: both
 * producers satisfy it. The wire type (`PromptWire`, where `grading`
 * is optional for API.md's passage question) and prompts.ts's factory
 * `Prompt` (where `grading` is required).
 */
export interface KanaAnswerablePrompt {
  readonly grading?: { readonly rule: string };
}

/**
 * D-2: `grading.rule === "normalized_exact"` is the ONLY discriminator
 * between kana-answer and English-answer fields — meaning and reading
 * are both `kind: "recall"` AND `bucket: "vocab_recog"`, so kind/bucket
 * cannot separate them, and instruction/stimulus copy is display text,
 * not a contract. `keyword` (meaning) and `production` fields are never
 * bound; Phase 3's unknown-word `recall/reading` prompts are covered
 * for free (same rule).
 */
export function isKanaAnswerPrompt(prompt: KanaAnswerablePrompt): boolean {
  return prompt.grading?.rule === "normalized_exact";
}

// D-4 — module-level handlers so bind/unbind add and remove the exact
// same references (the DOM ignores duplicate same-type adds). They flip
// the attribute the library's input handler checks, so a platform IME's
// composition is never mutated mid-composition on Windows/Linux/Android.

function onCompositionStart(event: CompositionEvent): void {
  const element = event.currentTarget;
  if (element instanceof HTMLInputElement) element.dataset.ignoreComposition = "true";
}

function onCompositionEnd(event: CompositionEvent): void {
  const element = event.currentTarget;
  if (element instanceof HTMLInputElement) element.dataset.ignoreComposition = "false";
}

/**
 * Attach the converter plus our composition guard to a kana-answer
 * `<input>`. Session.svelte calls this from an `$effect` gated on
 * isKanaAnswerPrompt — the production textarea and meaning inputs
 * never reach here. Idempotent: the library no-ops when already bound
 * and duplicate same-function listener adds are ignored by the DOM.
 */
export function bindKanaInput(element: HTMLInputElement): void {
  bind(element, KANA_INPUT_OPTIONS);
  element.addEventListener("compositionstart", onCompositionStart);
  element.addEventListener("compositionend", onCompositionEnd);
}

/**
 * Reverse bindKanaInput. The library's `unbind()` throws when no
 * listener is registered (verified above), so the attribute check
 * comes first; when it does run it also restores the attributes
 * bind() overwrote (lang, autocapitalize, spellcheck, …) and removes
 * `data-ignore-composition`. Our guard handlers are removed either way.
 */
export function unbindKanaInput(element: HTMLInputElement): void {
  element.removeEventListener("compositionstart", onCompositionStart);
  element.removeEventListener("compositionend", onCompositionEnd);
  if (element.hasAttribute("data-wanakana-id")) {
    unbind(element);
  }
}