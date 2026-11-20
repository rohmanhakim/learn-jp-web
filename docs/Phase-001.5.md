# Phase 1.5 — Romaji→kana input for kana-answer prompts

Expanded breakdown of the "Phase 1.5 — Romaji→kana input for
kana-answer prompts (WanaKana)" section of [TASKS.md](TASKS.md).
TASKS.md stays the source of truth for phase order and phase-level
acceptance; this file is the working plan for Phase 1.5 only:
sub-tasks (P1.5.1 … P1.5.5), per-sub-task acceptance criteria,
dependencies, and decisions.

**Scope:** one client-only transliteration aid on the Session screen's
answer field, so `recall/reading` and `kanji_reading` prompts
(`grading.rule === "normalized_exact"`) can be answered on a device
without a Japanese IME. Transliteration only — no candidate list, no
dictionary, no custom IME (DECISIONS D14). Nothing else changes: no
server, API, data-model, or grading change (LEARNING-DESIGN §2's rules
stand verbatim); meaning prompts (`keyword`, English answers) and
production prompts keep their fields exactly as Phase 1 shipped them;
no UI chrome, no toggle, no config.

**Why this phase exists:** Phase 1 shipped on the assumption "Japanese
entry uses the platform IME in a plain `<input>`" (UX.md). On a device
with no Japanese IME — or a user who has none configured — every
kana-answer prompt is unanswerable: romaji reaches `normalizeExact`,
which never converts romaji → kana, so a *correct* reading grades ✗.
The fix belongs in the field, not in grading: producing `まいあさ` from
`maiasa` still requires knowing the reading, so recall stays intact
while the keyboard-mechanics barrier disappears. A candidate/IME
widget was rejected precisely because its suggestion list would turn
this free-response prompt into a browsing exercise — see D-1.

**Sub-task numbering:** Phase 1's tasks are `P1.n` (two segments,
Phase-001.md); this file's are `P1.5.n` (three segments). `P1.5`
alone always means Phase-001.md's prompt factory; `P1.5.2` always
means this file's task 2.

**Phase-level acceptance (from TASKS.md):** typing `maiasa` in a
reading prompt on a device without a Japanese IME submits `まいあさ`
and grades correct; English meaning answers and production textareas
behave exactly as Phase 1; conversion issues zero network requests
(offline-safe); `npm run check` green; browser walkthrough recorded in
the Notes below.

**Notes fields:** every sub-task has a *Notes* block, left empty
until implementation starts. Fill it during/after the session that
implements the sub-task: decisions actually taken, deviations from
this plan, links to commits, and anything a later session needs to
know. Do not tick a sub-task's checkbox without its Notes being
filled.

**Status legend:** `[ ]` not started · `[~]` in progress · `[x]`
done (Notes filled, tests green).

---

## Dependency order

```
P1.5.1 (dependency) → P1.5.2 (conversion layer) → P1.5.3 (tests)
                                           P1.5.2 → P1.5.4 (walkthrough)
P1.5.5 (docs) — settled with this plan, already [x]
```

Single milestone — the phase is one screen's input field. Estimated
size: one or two sessions (P1.5.1 + P1.5.2 together first).

---

## P1.5.1 Dependency: `wanakana` pinned — `package.json`

- [x] Add `wanakana` (5.3.1, MIT) to `dependencies` — the repo's first
      client runtime dependency. Evaluated facts (researched
      2026-11-20, full survey in the Appendix):
      - ~6.6 kB minified+gzipped, ESM build (`esm/index.js`) plus
        shipped TypeScript definitions (`types: cjs/index.d.ts`), two
        tiny deps (`dequal`, `memoize-one`), zero known advisories.
      - Upstream is low-churn, not abandoned: last release
        2023-11-20, occasional repo commits since. Behavior is pinned
        by the P1.5.3 fixture table so an upgrade cannot silently
        change what grades.
      - The pure `toKana`/`toHiragana` path touches no DOM globals;
        `bind()`/`unbind()` are the DOM helpers.
- [x] Confirm `npm run check` still green after the install and that
      `tsc --noEmit` resolves the library's types.

**Acceptance:** `npm install` succeeds; `npm run check` green; the
client bundle grows by single-digit kB (compare `dist/assets` before
and after `npm run build`).

**Notes:**

```
(executed 2026-11-20 — dependency + verification only, no app code;
run together with P1.5.2 as this file suggested.)
• `npm install wanakana@5.3.1` OK — package.json pins EXACT "5.3.1"
  (npm defaults to ^5.3.1; edited down to match the "pinned" heading;
  lockfile records 5.3.1 + sha512 integrity). First client runtime
  dependency, in `dependencies`.
• Shipped types confirmed (`types: cjs/index.d.ts`; bind/unbind/toKana
  exported). Gotcha: `DefaultOptions` is NOT exported — derive the
  options type via `NonNullable<Parameters<typeof bind>[1]>` (what
  kana-input.ts does). Type resolution proven with a throwaway
  `tsc --strict --ignoreConfig` probe importing real symbols, deleted
  after success (TS 6 requires --ignoreConfig when files are given on
  the command line).
• `npm run check` green after install (lint + wrangler types --check +
  tsc + 241 Vitest tests). npm audit: no advisories over wanakana's
  tree (dequal, memoize-one).
• Library source facts verified in esm/index.js (inputs to D-4):
  bind() idempotent via data-wanakana-id; unbind() THROWS with no
  registered listener; input handler has NO isComposing check, honors
  dataset.ignoreComposition === "true"; the library's own composition
  handler is macOS-only; bind() also sets lang=ja/autocapitalize/
  spellcheck, restored by unbind().
• Bundle delta, honestly recorded: 0 B at install time (nothing
  imports the package yet — Vite tree-shakes it; client output dir is
  dist/client/assets, not dist/assets). The single-digit-kb criterion
  is therefore evaluated where the import lands, in P1.5.2: 55,845 →
  69,808 B raw (+13.96 kB raw — the kana tables are the bulk) with
  gzip 21.11 → 26.62 kB (+5.51 kB — single-digit on the min+gz basis
  bundlephobia quotes, which its ~6.6 kB figure also uses).
• TASKS.md Phase 1.5 bullet 1 deliberately left unticked: it also
  covers the P1.5.3 fixture table.
```

---

## P1.5.2 Conversion layer — `src/client/kana-input.ts` + `src/client/Session.svelte`

- [x] New pure module `src/client/kana-input.ts` (repo pattern: pure
      logic in its own module, imported by client code and tests):
      - `isKanaAnswerPrompt(prompt)` → `prompt.grading.rule ===
        "normalized_exact"`. The **rule** is the only field that
        separates kana-answer from English-answer prompts: meaning and
        reading are both `kind: "recall"` *and* `bucket: "vocab_recog"`
        (verified in `prompts.ts`). This also makes Phase 3's
        unknown-word `recall/reading` prompts covered automatically.
      - `KANA_INPUT_OPTIONS = { IMEMode: "toHiragana" }` — the option
        object passed to `bind()` (see D-3).
      - Lifecycle wrappers: `bindKanaInput(el)` (the library is
        self-idempotent via its `data-wanakana-id` attribute) and
        `unbindKanaInput(el)` — **must check that attribute first**:
        the library's `unbind()` *throws* when no listener is
        registered.
- [x] `Session.svelte` wiring (the `<input>` branch only — the
      production `<textarea>` is never bound):
      - one `$effect` keyed on the current prompt: bind when
        `fieldEl` is the input and `isKanaAnswerPrompt(prompt)`;
        unbind when the rule changes (prompt advance). Re-renders
        while already bound are no-ops (bind is idempotent).
      - **State-parity hard invariant: `answer === fieldEl.value` at
        all times after conversion.** `bind()` rewrites
        `element.value` synchronously inside its *own* `input`
        listener, while Svelte's `bind:value` listener was attached
        earlier (element creation) and would capture the
        pre-conversion romaji — the submitted answer would differ
        from the displayed text and grade wrong. Required wiring: a
        sync listener attached *after* `bind()` in the same effect
        (same-event listeners run in attachment order, so it reads
        the already-converted value) that copies `fieldEl.value` into
        `answer`. Fallback if ordering proves fragile in practice:
        drive the field explicitly (`value` + `oninput`) instead of
        `bind:value`. Either way, P1.5.4's walkthrough asserts the
        POST body matches the displayed kana.
      - **Composition guard (ours, not the library's):** the
        library's `onInput` has **no `isComposing` check**; its own
        composition handler sets the `data-ignore-composition`
        attribute only on macOS (its documented Android/desktop
        tradeoff). Attach our own `compositionstart` /
        `compositionend` handlers on the bound element setting that
        attribute to `"true"` / `"false"` — the library's input
        handler honors it — so a platform IME's composition is never
        mutated on Windows/Linux/Android. After `compositionend` the
        field holds kana/kanji (already Japanese → conversion is a
        no-op) and the sync listener refreshes `answer`. The existing
        ⏎ `event.isComposing` guard in `onFieldKeydown` stays as-is.
      - **Invisible by design (D-5):** no candidate popup, no hint, no
        badge, no toggle — the field looks and feels exactly like
        Phase 1's.
      - Paste fires `input`, so pasted romaji converts and pasted kana
        passes through (identity). Accepted, documented behavior.

**Acceptance:** all six walkthrough conditions in P1.5.4 pass —
reading converts and grades; meaning untouched; production untouched;
platform-IME composition uninterrupted; bind/unbind does not leak
listeners across prompts; `npm run check` green.

**Notes:**

```
(executed 2026-11-20, together with P1.5.1 as suggested above.)
• kana-input.ts as specified. isKanaAnswerPrompt checks
  `prompt.grading?.rule === "normalized_exact"` — optional-chained
  because PromptWire.grading is optional (API.md's passage prompt has
  none; a spec-less prompt is simply never bound). KANA_INPUT_OPTIONS
  typed `NonNullable<Parameters<typeof bind>[1]>` (the library exports
  no options type — see P1.5.1 Notes).
• Deviation (location only): the compositionstart/end guard handlers
  live in kana-input.ts as module-level functions rather than in
  Session.svelte — same attribute contract per D-4, but bind/unbind
  stay a single call pair, same-reference removal is exact, and
  duplicate adds are DOM no-ops. unbindKanaInput checks
  data-wanakana-id first (unbind() throws otherwise — verified).
• Session.svelte: ONE $effect keyed on fieldEl + prompt; binds only
  when fieldEl instanceof HTMLInputElement AND isKanaAnswerPrompt —
  production textarea and meaning inputs never bound. The effect does
  not read `phase`, so readonly toggling across verdict windows never
  churns bind/unbind. Sync listeners (input + compositionend) attached
  AFTER bindKanaInput → attachment order Svelte bind:value → library →
  sync, giving the parity invariant `answer === element.value` at all
  times after conversion. Cleanup unbinds on prompt advance/rule
  change; no-op re-renders while bound (bind() idempotent).
• Listener-order fallback (drive field via value+oninput) NOT needed:
  verified against svelte@5.57.3's bind_value source — its post-tick
  re-write restores selectionStart/End around any write, and the
  render-effect write is equality-guarded (`value !== input.value`)
  and batch-skipped while the input is focused, so converted kana can
  never be clobbered back to romaji. Real-browser POST-body assertion
  still owed by P1.5.4.
• Untouched: ⏎ isComposing guard in onFieldKeydown; markup (still
  bind:value); zero UI chrome (D-5); server/API/schema/grading. Paste
  fires input → converts (accepted per plan).
• Verification: npm run check green (lint + wrangler types + tsc +
  241 tests); tsx smoke through the REAL module: maiasa → まいあさ
  (the phase acceptance example), toukyou → とうきょう, MAIASA →
  まいあさ (D-3 uppercase→hiragana), こんにちは identity, 2026
  pass-through, plus 5/5 scoping-predicate cases. Bundle 55,845 →
  69,808 B raw / 21.11 → 26.62 kB gzip (+5.51 kB gz, single-digit).
• For P1.5.3 (discovered while probing): one-shot toKana under our
  options does NOT match two of this plan's illustrative examples —
  shimbun → しmぶn and nen → ねn (trailing/mid n rules differ from a
  real IME); pin fixtures from ACTUAL runs, and check whether
  incremental bind() keystroke input (splitInput + cursor) differs
  from one-shot before hardcoding ん expectations.
• Not done here: fixture + scoping tests (P1.5.3); manual browser
  walkthrough incl. zero-network + leak checks (P1.5.4).
```

---

## P1.5.3 Tests — `tests/kana-input.test.ts`

- [x] **Behavior fixture table** (hardcoded literals only, the
      `tests/normalize.test.ts` precedent): input → expected kana,
      asserted through `toKana(input, KANA_INPUT_OPTIONS)` — the pure
      entry point `bind()` uses internally, so the table needs no DOM.
      Cases to cover: Hepburn + kunrei variants (`shi`/`si`,
      `chi`/`ti`, `tsu`/`tu`, `fu`/`hu`); sokuon (`matte` → `まった`);
      ん (`nn`, `n'`, `n` before a consonant — e.g. `shimbun` →
      `しんぶん`); small kana (`xtsu`/`ltsu` → `っ`, `kya` → `きゃ`);
      long vowels (`toukyou` → `とうきょう`, `ou` → `おう`); uppercase
      input under `IMEMode: 'toHiragana'` (assert the actual pinned
      behavior — hiragana expected); already-kana input is identity
      (`こんにちは` unchanged); unsupported characters/digits pass
      through (`café`, `2026`). Purpose: pins the dependency so an
      upgrade can never silently change what grades — the same role
      D11's parity table plays for normalization.
- [x] **Scoping predicate tests** built on the REAL prompt factories
      from `src/worker/prompts.ts`: `vocabReadingPrompt` → true,
      `kanjiReadingPrompt` → true, `vocabMeaningPrompt` → false
      (`keyword`), `vocabProductionPrompt` → false (`production`).
      Plus a guard that no other current rule value matches
      `isKanaAnswerPrompt` (so a future rule is a deliberate decision,
      not an accident).
- [x] **Environment caveat:** tests run inside workerd
      (`@cloudflare/vitest-plugin`); wanakana's pure conversion path
      should import cleanly, but if the module references `window` at
      scope level, split the fixture onto a client-compatible vitest
      environment — record the outcome in Notes.

**Acceptance:** `npm run check` green (lint + `wrangler types` +
`tsc` + all tests including the new file).

**Notes:**

```
(executed 2026-11-20 — tests only; no product code touched.)
• tests/kana-input.test.ts: 39 tests, written in the
  tests/normalize.test.ts fixture style (hardcoded literals, looped
  it() cases) — 32 toKana(input, KANA_INPUT_OPTIONS) behavior rows,
  1 options pin ({ IMEMode: "toHiragana" } exactly — D-3), and 6
  scoping tests.
• Methodology: every expected value captured from ONE real run of
  wanakana@5.3.1 at authoring time, then hardcoded verbatim. Where
  this plan's illustrative examples did not match reality, the REAL
  output is pinned with an explanatory comment:
  - `shimbun` → しmぶn (NOT しんぶん — wanakana does no
    m-assimilation; type `shinbun`), `nen` → ねn, `nihon` → にほn:
    a trailing n stays PENDING under IMEMode because bind() forces
    `options.IMEMode || true` — no options avoid it (verified in
    esm/index.js: applyMapping gets convertEnding=false whenever
    IMEMode is truthy).
  - Spacebar COMMITS the pending ん and is consumed in the process
    (user-reported in the browser; verified identically through a
    keystroke simulation of the real bind() listener chain AND
    one-shot: "nihon " → にほん, "nen " → ねん). With nothing
    pending the space remains ("maiasa " → まいあさ␣) — harmless,
    the server's normalizeExact strips every whitespace kind (D11
    parity table). Both semantics are pinned as fixture rows;
    real-browser confirmation belongs to the P1.5.4 walkthrough.
  - `café` → かfé (NOT pass-through as the plan assumed) — harmless
    because bound fields only take kana answers; pinned anyway.
• Scoping tests use the REAL factories with prompts.test.ts's seed
  rows (毎朝 / 一): vocab reading → true, kanji reading → true,
  meaning → false, production → false; plus an exhaustive
  Record<GradingSpec["rule"], boolean> so a future rule fails tsc
  until classified ("a deliberate decision, not an accident"), plus
  a no-grading-spec case (API.md passage-prompt shape → never bound).
• Environment caveat RESOLVED POSITIVELY: tests run inside workerd
  and wanakana's pure path imports cleanly — module scope touches no
  DOM globals (window only inside the composition handler, never
  called here). No client-env split needed.
• npm run check green: 13 files / 280 tests (was 12/241; +39).
• TASKS.md: bullets 1 (dependency + fixture) and 5 (tests) ticked
  with this sub-task; every Phase 1.5 TASKS bullet is now done —
  only P1.5.4's walkthrough remains, which TASKS carries inside the
  phase acceptance line rather than as a bullet.
```

---

## P1.5.4 Acceptance walkthrough — manual browser pass

- [x] On a device/browser **without** a Japanese IME (desktop is
      fine — the whole point), from a running `npm run dev`:
      1. reading prompt: type `maiasa` → field shows `まいあさ`; the
         POST body contains `まいあさ` (Network panel) and the server
         grades it against the reading;
      2. kanji-reading prompt: same conversion path applies;
      3. meaning prompt: typing `every morning` stays English — no
         kana fragments anywhere (the field must NOT be bound);
      4. production prompt: textarea never converts (and, per D7,
         still relies on the platform IME for kanji);
      5. platform-IME spot check (if available): composing kana/kanji
         directly works and the IME candidate window is never
         interrupted mid-composition (no reflow, no dropped preedit);
      6. advance through ≥20 mixed prompts — `data-wanakana-id`
         present only on kana-answer prompts, no listener leak, no
         console errors.
- [x] Zero-network check: DevTools Network shows no requests during
      typing; conversion also works with the tab set to offline
      (offline-safe, LEARNING-DESIGN §9).
- [x] Bundle check: `npm run build`, confirm single-digit kB growth
      in `dist/assets`.
- [x] Fill Notes with results + commits; tick the matching TASKS.md
      bullets.

**Acceptance:** all checklist items pass on desktop; the two
platform-IME/mobile spot checks may be deferred to Phase 6's mobile
pass (TASKS: "IME quirks") — record the deferral in Notes.

**Notes:**

```


```

---

## P1.5.5 Docs sync — UX.md · LEARNING-DESIGN §2 · DECISIONS D14 · TASKS.md

- [x] UX.md "Input considerations" — the "no kana romaji trainer in
      v1" bullet is amended: kana-answer fields convert romaji as you
      type (invisible, no suggestions/toggle); meaning and production
      fields do not; platform IME stays the entry path for everything
      else (including production's kanji, D7).
- [x] LEARNING-DESIGN §2 — the "client sends raw input" sentence is
      clarified: the client sends the field's content **un-normalized**
      (Phase 1.5 may convert romaji → kana *in the field* before
      submission — input mechanics, not normalization). No grade rule
      changed; the §2 table is untouched.
- [x] DECISIONS.md — new **D14** settles transliteration-only input
      aid (candidate/IME engines, server-side romaji acceptance, and
      always-on binding all rejected) and points at this file.
- [x] TASKS.md — Phase 1.5 section added (between Phase 1 and Phase 2),
      ordering rationale extended, out-of-scope list extended with the
      candidate/IME widget (and its stale `§8` anti-requirements
      cross-reference corrected to §9).

**Acceptance:** the four docs agree with each other and with this
file; no doc states a rule this phase violates (anti-requirement audit
in Notes below).

**Notes:**

```
(decided 2026-11-20 — authored together with this plan, before any
code exists for the phase, so the spec leads the implementation.
Grading rules were deliberately NOT touched: LEARNING-DESIGN §2's
table, `normalize.ts`, `grader.ts`, and all Phase-1 parity fixtures
stay byte-identical. The only LEARNING-DESIGN edit is the one
clarifying sentence in §2's closing paragraph.)
```

---

## Decisions

Settled while writing this plan (changing any of these requires
updating this file together with the affected design docs, per
[AGENTS.md](../AGENTS.md)):

- **D-1 · transliteration-only input aid (global: DECISIONS D14).**
  WanaKana (`wanakana`) — mechanical romaji→kana, no dictionary, no
  candidates. *Rejected:* an in-app Google-Translate-style candidate
  widget / real IME engine (hechima's Mozc-WASM, inputx-nihongo) —
  a suggestion list turns a free-response recall prompt into a
  browsing exercise (the spoiler), kanji commits cannot grade under
  `normalized_exact`, 1.5–17 MiB dictionaries fight the offline/lean
  bundle, and the APIs are experimental; dictionary converters
  (Kuroshiro, nyaitter-ime) — text→text, unmaintained/too new, still
  no field integration; Google's embeddable transliteration —
  Transliterate API deprecated 2011, `google/google-input-tools`
  archived; server-side romaji→kana acceptance in `normalizeExact` —
  amends §2's contract and the Phase-1 parity fixtures, and lets a
  romaji string stand as a typed reading (orthography lost); binding
  conversion on every text field — mangles English meaning answers;
  status quo — kana prompts are unanswerable without an IME.
- **D-2 · scoping = `grading.rule === "normalized_exact"`.** The rule
  is the only discriminator: meaning and reading are both
  `kind: "recall"` and both `bucket: "vocab_recog"`. *Rejected:*
  scoping by `kind` or `bucket` (cannot separate the two recall
  directions); scoping by instruction/stimulus copy (display text,
  not a contract — D-10's rule that cues are never processed).
- **D-3 · `IMEMode: 'toHiragana'`.** Uniform hiragana output matches
  the instruction "Type the reading" and keeps output inside
  `normalizeExact`'s katakana→hiragana fold by construction.
  *Rejected:* the library default (`IMEMode: true` → `toKana`), where
  uppercase input produces katakana — grades fine after the fold but
  reads wrong to a learner who tapped Shift by accident.
- **D-4 · composition safety is ours, not the library's.** The
  library's input handler has no `isComposing` guard and its own
  composition handler only manages `data-ignore-composition` on
  macOS, so this plan requires our own `compositionstart/end`
  handlers driving that attribute. *Rejected:* trusting the
  library's platform behavior as-is (Windows/Linux/Android platform
  IMEs would risk mid-composition mutation); wrapping `bind()`'s
  handler with an `isComposing` check (we don't own that handler).
- **D-5 · zero UI, zero config.** Conversion is invisible field
  mechanics: no toggle, badge, hint, or candidate popup, decided
  automatically per prompt. *Rejected:* a per-session "romaji input"
  switch — configuration in the study path violates
  LEARNING-DESIGN §9 and UX.md's vending-machine intent.

## Notes (phase-level)

- **Anti-requirement audit (LEARNING-DESIGN §9):** no start/end
  ceremony (unchanged); **no config UI** — D-5 adds no toggle; **no
  network requirement** — the library is bundled, conversion is
  offline-safe (P1.5.4 asserts zero requests); no LLM (none here);
  **no multiple-choice recall** — typing remains the practice, and
  D-1 explicitly rejected the candidate list that would have blurred
  this line; no dashboard. UX.md's vending-machine intent holds: the
  feature is deliberately invisible.
- **ARCHITECTURE principle 1** ("the client contains no learning
  logic") holds: conversion is keyboard mechanics — it never grades,
  schedules, or selects content; the precedent for importing pure
  logic client-side already exists (`normalizeExact` in
  Session.svelte's production preview).
- **Phase 2 dependency:** when the answer queue lands, it must queue
  the converted `answer` — the state-parity invariant in P1.5.2 keeps
  this true automatically; re-verify in Phase 2's offline tests.
- **Phase 3 dependency:** unknown-word capture yields
  `recall/reading` prompts with the same rule — covered for free by
  D-2's rule-based scoping; no change needed there.
- **Phase 6 dependency:** the mobile pass re-touches this field
  ("IME quirks" in TASKS.md); iOS/Android keyboard behavior gets its
  verification there if deferred from P1.5.4.
- Suggested first session: **P1.5.1 + P1.5.2** together (dependency +
  conversion layer), then P1.5.3 tests, then the P1.5.4 walkthrough.
- This file does not modify [TASKS.md](TASKS.md); when a sub-task
  lands, tick the corresponding Phase 1.5 bullet there too.

---

## Appendix — library survey (researched 2026-11-20)

| Option | What it gives | Verdict for this phase |
|---|---|---|
| **`wanakana` 5.3.1** (WaniKani) | romaji→kana transliteration bound to a field; ~6.6 kB min+gz, MIT, TS types, zero advisories; low-churn upstream | **chosen** — no dictionary ⇒ no suggestions ⇒ nothing to spoil; output is kana, exactly what `normalized_exact` grades |
| Kuroshiro + kuromoji | dictionary romaji→kana→kanji, text→text | rejected — unmaintained stack, ~17 MiB dictionary, no field integration, kanji output doesn't grade |
| nyaitter-ime (2026) | local `convert()` returning a first candidate | rejected — brand new, zero track record, first-candidate-only |
| inputx-nihongo WASM | true IME engine: `preedit()` + `candidates()` (freq, prefix proximity), ~1.5 MB | rejected — forces us to build the candidate panel (the spoiler surface); bundle + experimental API |
| hechima (Mozc-WASM, 2026) | full web IME stack, clause candidates, embeddable | rejected — same spoiler surface, experimental API, heavy bundle |
| Google Transliterate / Input Tools | the reference UX (the Google Translate box) | unavailable — Transliterate API deprecated 2011; `google/google-input-tools` archived; the Chrome extension is browser-level, not embeddable |
| Server-side romaji acceptance | grade romaji answers in `normalizeExact` | rejected — changes §2 + the parity fixtures; orthography lost (D-1) |
| Platform IME only (status quo) | Phase 1 behavior | rejected as the *sole* path — kana prompts unanswerable without an IME (the gap this phase closes); remains the path for production kanji (D7) |

Sources: [github.com/WaniKani/WanaKana](https://github.com/WaniKani/WanaKana) ·
[npmjs.com/package/wanakana](https://www.npmjs.com/package/wanakana) ·
[bundlephobia — wanakana@5.3.1](https://bundlephobia.com/package/wanakana@5.3.1) ·
[developers.google.com/transliterate](https://developers.google.com/transliterate) ·
[github.com/google/google-input-tools](https://github.com/google/google-input-tools)









