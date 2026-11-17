# Phase 1 — The core loop (MVP)

Expanded breakdown of the "Phase 1 — The core loop (MVP)" section of
[TASKS.md](TASKS.md). TASKS.md stays the source of truth for phase
order and phase-level acceptance; this file is the working plan for
Phase 1 only: sub-tasks (P1.1 … P1.16), per-sub-task acceptance
criteria, dependencies, and open decisions.

**Scope:** recall prompts (+ vocab `production` with self-grade) — the
loop itself exists before content depth. No `passage_question` or
`writing`-bank prompts (those are Phases 3–4), no offline paths
(Phase 2), no LLM, no third-party integrations, no external services.

**Phase-level acceptance (from TASKS.md):** complete the
product-level definition of done against the local dev server,
desktop browser — open app → one button → 10 min of graded prompts →
performance saved → next session visibly adapted → repeat, with
tap-to-first-prompt ≤ 5 s and zero manual setup.

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
P1.1 → P1.2, P1.3 → P1.4        (pure core; P1.2/P1.3 parallel after P1.1)
        P1.4, P1.1 → P1.5 → P1.6
P1.6, P1.4, P1.2 → P1.7 → P1.8 / P1.9 / P1.10 / P1.11   (C may split across sessions)
P1.7 → P1.12 → P1.13 → P1.14;  P1.10 + P1.13 → P1.15
everything → P1.16
```

Milestones: **A** pure domain core (P1.1–P1.4) · **B** prompting &
builder (P1.5–P1.6) · **C** API & persistence (P1.7–P1.11) ·
**D** frontend (P1.12–P1.15) · **E** acceptance (P1.16).

---

## Milestone A — Pure domain core (no DB, no HTTP)

### P1.1 Shared types & item-key helpers — `src/worker/keys.ts`

- [x] Types shared everywhere: `Grade` (`correct|shaky|incorrect`),
      `Bucket` (`vocab_recog|kanji|reading|writing`), prompt kinds,
      self-grade (`solid|shaky|wrong`).
- [x] Pure builders/validators for DATA-MODEL "Item keying" formats:
      `vocab:jlpt:n5:毎朝:meaning` · `…:reading` · `…:produce` ·
      `kanji:一:onkun`; and `prompt_key` formats per API.md
      (`r:jlpt:n5:毎朝:meaning`, `w:jlpt:n3:合図:produce`).

**Acceptance:** unit tests cover key round-trips and rejection of
malformed keys; types are importable by every later module without
pulling in DB or HTTP code.

**Notes:**

```
(started: 2026-11-17 · decided: (1) prompt_key shapes not shown in API.md
settled as `r:kanji:一:onkun` (kanji reading) and `w:n3:school-day`
(writing bank) — `w:jlpt:…` (production) vs `w:<level>:…` (writing) can
never collide because segment 2 is `jlpt` vs an n1..n5 level, and the
parsers enforce exact segment counts; (2) error style: builders take
typed/trusted input and throw on invalid segments (empty, contains `:`,
ordinal < 1 or non-integer), parsers handle untrusted API-supplied keys
and return null on any malformed key (wrong segment count, bad level,
unknown prefix/direction, `q` segment must match q[1-9][0-9]*);
(3) `itemKeyFromPromptKey` is the single prompt→item mapping for the
builder and /api/responses (P1.10); capture prompts map to null (D-5 —
no SRS identity until queued); (4) shared enums ship as const arrays +
type unions with runtime guards (isLevel/isGrade/isSelfGrade/isBucket/
isPromptKind/isVocabDirection) for P1.7/P1.10 request validation ·
commits: (not committed — `npm run check` green: 47 new tests in
tests/keys.test.ts, 54 total) )
```

### P1.2 SM-2 kernel — `src/worker/srs.ts`

- [x] Pure function `applyGrade(state, grade, now) → next state`
      implementing LEARNING-DESIGN §1 verbatim — no DB access, no
      hidden inputs (time is a parameter).

**Acceptance:** unit tests for **every** grade path named in
TASKS.md:

| Path | Expected |
|---|---|
| first rep (`correct`, reps 0→1) | `interval_days = 1` |
| second rep (reps 1→2) | `interval_days = 3` |
| mature rep | `round(previous × ease)`, ease unchanged |
| `shaky` | `interval = max(1, interval × 1.2)`, ease −0.05 |
| `incorrect` | `interval = 0`, `due_at = now`, lapses +1, ease −0.20 |
| ease floor | ease never below 1.3 |
| new item defaults | interval 0, due_at = now, ease 2.5 |

**Notes:**

```
(started: 2026-11-17 · decided: (1) D-6 — `incorrect` resets `reps`
to 0 (ladder re-entry); LEARNING-DESIGN §1 amended in the same
change: without the reset a lapsed item computes `round(0 × ease) =
0` and stays due forever, while `shaky` recovered via `max(1, 0 ×
1.2)` — the gap was in the pseudocode, not intent; (2) state =
scheduling columns only (ease/intervalDays/dueAt/reps/lapses/
lastGrade) — item_key/kind/suspended stay with the caller, so the
result spreads straight into a Drizzle row update (P1.10);
`lastGrade` set on every path (column exists, §1 silent); `now:
Date` in, `dueAt` out as UTC ISO-8601 — always set explicitly,
never via the column's `datetime('now')` default, so lexicographic
`due_at <= ?` comparisons see one format; (3) due timestamps use
`Math.round(interval × 864e5)` ms — sub-ms float dust after shaky's
×1.2 must not leak into stored ISO text; (4) shaky never bumps
`reps` (§1 gives reps only to `correct`); fractional intervals are
REAL and feed the mature formula (3.6 × 2.5 → 9) · commits: (not
committed — npm run check green: 16 new tests in tests/srs.test.ts,
70 total) )
```

### P1.3 Text normalization + parity fixtures — `src/worker/normalize.ts`

- [x] `normalizeExact`: NFKC → strip whitespace → katakana→hiragana
      (reading-answer path).
- [x] `normalizeKeyword`: lowercase → NFKC → strip punctuation /
      whitespace; plus expected-keyword splitting on `;` `,`
      `(`…`)`.

**Acceptance:** unit tests include a **parity fixture table with
hardcoded** input→expected-output literals (never generated at
runtime) — this guards the one TS portability risk flagged in D11
(JS `String.normalize('NFKC')` semantics vs the original Python
tooling). Fixtures cover full/half-width, katakana/hiragana,
whitespace, and punctuation cases.

**Notes:**

```
(started: 2026-11-17 · decided: (1) D-7 (Decisions below) — parenthetical
groups dropped BEFORE splitting on `;`/`,`; LEARNING-DESIGN §2 amended in
the same change; (2) orders verbatim from §2/this file — `normalizeExact`:
NFKC → strip `[\s\p{Cf}]` (whitespace incl. U+3000/NBSP, plus invisible
format chars like U+200B) → fold U+30A1–U+30F6 by −0x60 (`ー`, `ヷヸヹヺ`,
`ヽヾ` untouched, pinned by fixture); `normalizeKeyword`: lowercase → NFKC
→ keep only `\p{L}`/`\p{N}` (en dash, `・`, `！`, quotes all fall out with
punctuation; NO kana folding on the keyword path — §2 doesn't ask for it,
pinned deliberately so the asymmetry with exact is a choice, not a bug);
(3) exported splitter name `expectedKeywords(raw)` returns already
normalized, deduped keywords (first-seen order) so P1.4 is pure
containment: NFKC-fold → depth-aware `(...)` drop (1 seed row nests:
`dog (Canis (lupus) familiaris)…`) → split `[;,]` → normalizeKeyword →
drop empties → dedupe; unbalanced brackets are absent from the seed but
tolerated (stray `)` dropped, unclosed `(` swallows the rest, both pinned
by fixture); (4) parity (D11): halfwidth dakuten composes under NFKC in
BOTH engines (`ﾊﾟ`→`パ`→`ぱ`; `か+U+3099`→`が` U+304C), and a Python
`unicodedata` replica of the whole pipeline was run one-off at authoring
time over all 8,334 seed meanings with identical output — fixture
literals themselves are hardcoded, never generated at runtime; (5) seed
reality checked: 7,818 meanings use `;`, 2,844 use `(`, 864 have a comma
inside parens, 0 unbalanced and 0 ideographic punctuation (、；，：（）),
so no ideographic splitting was added — every meaning yields ≥1 keyword
(enforced by a seed smoke test over all rows); (6) heads-up for P1.4:
seed glosses yield 13 single-char keywords (`i`, `a`, `b`, digits, `圓`)
and short ones like `or`/`in`/`me` — with containment-either-way that
loosens grading (any answer containing `i` would pass that word);
grader-side handling is deliberately out of P1.3's scope · commits: (not
committed — npm run check green: 52 new tests in tests/normalize.test.ts,
122 total) )
```

### P1.4 Grading rules — `src/worker/grader.ts`

- [x] `keyword` (recall/meaning): any expected keyword contained in
      the answer **or** vice versa → correct; partial token overlap
      only → `shaky` (decision D-4); none → incorrect.
- [x] `normalized exact` (recall/reading, kanji_reading): equals any
      reading alternative after normalization.
- [x] `production` merge matrix: checks pass + `solid` → correct;
      checks pass + `shaky` → shaky; checks fail **or** `wrong` →
      incorrect.
- [x] Grading result carries the correct answer through for the
      inline "learning moment" display (UX: `✗ — correct was …`).

**Acceptance:** unit tests cover each rule (hit, miss,
multi-alternative, partial→shaky) and the full production merge
matrix; grader takes raw input + stored grading spec only (client
sends raw, server normalizes — UX.md).

**Notes:**

```
(started: 2026-11-17 · decided: (1) D-8 (Decisions below) — `keyword`
matches on full normalized equality OR contiguous token-sequence
containment either way, never substring: the P1.3 heads-up was shown
to misgrade real seed cases (`thing` ⊃ `in`, `news` ⊃ `new`, `earth`
⊃ `art`, `this` ⊃ single-char `i`), and a length floor would fix only
the ≤2-char keywords while leaving ≥3-char substrings broken;
LEARNING-DESIGN §2's keyword row amended in the same change;
(2) D-4 partial = ≥1 shared token between the raw answer and the raw
alternatives' tokens (tokenize = lowercase → NFKC → split on
non-alphanum — same char class as `normalizeKeyword` but keeping the
word boundaries matching needs); zero shared tokens, or an
empty/whitespace/punctuation-only answer → incorrect; (3) production:
§2 merge matrix verbatim, plus null `self_grade` with passing checks
→ shaky — never credit `correct` without the user's verdict (P1.7's
schema will require the field anyway); `must_contain` compared via
`normalizeExact` on both sides (symmetric NFKC/width/kana fold —
target as written, kanji↔kana never converts), all-or-nothing across
tokens, each verdict returned in `checks` for UX's `✓/✗ contains`
line; empty `must_contain` = vacuous pass (P1.5 always emits ≥1);
(4) types exported from `grader.ts`: `GradingSpec` union
(`keyword`/`normalized_exact`/`production` with RAW
`alternatives`/`must_contain` strings — the grader owns all
normalization, P1.7 derives its Zod schemas from this union) and
`GradeResult { grade, correctAnswer, checks? }` — `correctAnswer` =
raw alternatives joined `"; "` (the §2 learning moment),
`checks` only on production; rule-name spelling settled as
`normalized_exact`; (5) `normalize.ts` gained `splitAlternatives()`
(paren-drop → split on `;`/`,` → trim → drop empties — the raw view of
the same pipeline `expectedKeywords` runs; `expectedKeywords`
refactored onto it, its 52 fixtures unchanged); grader is total:
unknown rule and empty answers grade incorrect, never throws ·
commits: (not committed — npm run check green: 25 new tests in
tests/grader.test.ts, 147 total) )
```

---

## Milestone B — Prompting & session builder

### P1.5 Prompt factory — `src/worker/prompts.ts`

- [ ] Vocabulary/kanji row → prompt object (`prompt_key`, `kind`,
      `bucket`, `is_new`, `instruction`, `stimulus`, `input`,
      `grading`) exactly in API.md shapes.
- [ ] `kanji_reading` accepts on **or** kun reading when the word
      permits both (LEARNING-DESIGN §2).
- [ ] `production` → `grading: { rule: "production", must_contain: [surface] }`.

**Acceptance:** golden-prompt tests for one vocab `meaning`, one
vocab `reading`, one `kanji_reading`, and one `production` prompt;
keys match P1.1 formats so the builder and `/api/responses` agree on
`prompt_key`/`item_key`.

**Notes:**

```
(started: · decided: · commits: )
```

### P1.6 Session builder v1 — `src/worker/session-builder.ts`

- [ ] Reviews: `srs_state` where `due_at ≤ now AND suspended = 0`,
      cap 25, oldest-due first (overflow rolls to next session).
- [ ] New items: 3 drawn from the **weakest bucket** by 7-day
      rolling accuracy (buckets with no data = neutral, not
      weakest); kind mix follows the bucket (e.g. `kanji` →
      `kanji_reading` prompts, `writing` → production).
- [ ] Level heuristic: lowest level where new items remain.
- [ ] No content piece (LEARNING-DESIGN §4 rule 3 skipped in v1).
- [ ] `adaptation_note`: one human sentence — what was focused on
      and why (API.md example style).
- [ ] Emits the snapshot JSON for the `sessions.snapshot` column,
      including `fast_skip_available: true` when the `sessions`
      table is empty (drives P1.15).

**Acceptance** (tests run in workerd against seeded D1, following
tests/seed.test.ts conventions):

- due selection honors cap + oldest-due ordering;
- weakest-bucket draw; neutral-bucket handling;
- if `reading` is weakest but no passages exist, falls back to the
  next actionable bucket (never serves a `passage_question` in v1);
- builder **never returns zero prompts** (D3: never a dead end — an
  8,334-row bank guarantees unseen items in v1);
- `adaptation_note` present and reflects the actual draw.

**Notes:**

```
(started: · decided: · commits: )
```

---

## Milestone C — API & persistence

### P1.7 Shared API contract — `src/worker/api-types.ts`

- [ ] Zod schemas for every request/response in API.md (status,
      session/start, responses batch + per-item results,
      session/complete), built with `@hono/zod-validator`.
- [ ] Export `AppType` from the Hono app; PWA consumes it via
      `hc<AppType>`.

**Acceptance:** `npm run typecheck` proves request/response types
compile-time checked on both ends (D11); a contract test parses the
documented example payloads from API.md as valid; no duplicated
hand-written interfaces on the client.

**Notes:**

```
(started: · decided: · commits: )
```

### P1.8 `GET /api/status` (replace Phase 0 stub)

- [ ] Real payload: `streak_days`, `last_session`, `due_count`,
      `totals`, `weakest_bucket`.
- [ ] Streak computed from `sessions` (decision D-3 below).

**Acceptance:** tests for empty DB (first run), single session, and
multi-day streak; `due_count` matches the builder's due query;
`weakest_bucket` matches the builder's bucket computation (same
shared helpers, not a second implementation).

**Notes:**

```
(started: · decided: · commits: )
```

### P1.9 `POST /api/session/start`

- [ ] Calls the builder; inserts `sessions` row (`client_uuid`,
      `started_at`, `snapshot`); response
      `title: "Session N · 10–15 min"`.

**Acceptance:** tests prove (a) fresh start persists the snapshot
verbatim, (b) replaying the same `session_uuid` returns the
**identical body** with no second row (UNIQUE + idempotency per
API.md), (c) the response parses as the `AppType` schema.

**Notes:**

```
(started: · decided: · commits: )
```

### P1.10 `POST /api/responses` (batch)

- [ ] Per item: grade server-side (P1.4) → apply SM-2 (P1.2) →
      upsert `srs_state`, insert `responses` row.
- [ ] Partially-successful semantics: per-item `results`, known
      `response_uuid`s reported `duplicate: true` (client drops
      them from its queue).
- [ ] `kind_hint: "fast_skip"` → `srs_state` row with
      `suspended = 1, due_at = now + 30d` (LEARNING-DESIGN §1
      fast-skip) plus the summary-derivable record per decision
      D-1.
- [ ] `kind_hint: "unknown_word"` → **deferred to Phase 3** (no
      passages exist yet); contract may reserve the field (D-5).

**Acceptance:** tests cover a mixed-grade batch updating SRS
correctly (including ease-floor and lapse paths exercised through
the endpoint, not just the kernel), replay → `duplicate: true` with
no double-count and no SRS re-application, the fast-skip path
creates a suspended row, and mid-batch duplicates are reported per
item while non-duplicates still land.

**Notes:**

```
(started: · decided: · commits: )
```

### P1.11 `POST /api/session/complete`

- [ ] Finalizes the session row (`completed_at`, `duration_sec`,
      `stats` JSON per DATA-MODEL "Session stats").
- [ ] Response `summary`: reviews/new done+correct counts, streak.
- [ ] `next_session.preview` + `note` derived from a **real builder
      projection** ("8 reviews · 3 new (kanji readings)" — no
      passage line in v1).

**Acceptance:** tests verify summary math against known responses,
preview counts match the actual next-start composition for the
post-session DB state, and completing an already-completed session
is idempotent (no stat inflation).

**Notes:**

```
(started: · decided: · commits: )
```

---

## Milestone D — Frontend (Svelte 5; Phase 1 target = desktop)

### P1.12 App shell + API client + Home

- [ ] Minimal view switching Home → Session → Done (no router
      library; UX has exactly three screens).
- [ ] `hc<AppType>` client module — the only place the app talks to
      the API.
- [ ] Home per UX.md: streak, "Last: …", single **Start session**
      CTA; loading replaces the CTA label ("Preparing…"), never a
      spinner-only screen. (Offline CTA states are Phase 2.)

**Acceptance:** manual — one tap from open to prompt 1 on local dev
stays within the ≤5 s tap-to-first-prompt metric; no screen sits
between open and the first prompt (UX hard rule).

**Notes:**

```
(started: · decided: · commits: )
```

### P1.13 Session screen

- [ ] One prompt at a time; slim header `n/total · progress · ✕`
      (exit = confirm → partial session saved → Done-lite).
- [ ] Recall: text input, ⏎ submit → inline verdict ~1.2 s → next;
      **wrong shows the correct answer** inline.
- [ ] Production: textarea + self-grade `✓ solid / ~ shaky / ✗ wrong`
      appearing only after submit; desktop shortcuts `1/2/3`;
      deterministic check feedback (`✓ contains 合図`) shows
      regardless of self-grade.

**Acceptance:** manual walkthrough of a recall flow and a
production flow matching the UX.md mockups; exit mid-session keeps
partial responses (they count toward the Done summary); no network
block on showing the next prompt.

**Notes:**

```
(started: · decided: · commits: )
```

### P1.14 Done screen

- [ ] Summary counts, streak, `next_session.preview` + adaptation
      note, single **Done** button → Home.
- [ ] After the last prompt, the Session screen is replaced by Done —
      never routed back through Home in between.

**Acceptance:** manual — Done reflects the completed session's real
data (no placeholders), and the preview sentence matches what the
next `session/start` actually serves.

**Notes:**

```
(started: · decided: · commits: )
```

### P1.15 First-run fast-skip UI ("I know this")

- [ ] "I know this" action on every recall prompt when the snapshot
      has `fast_skip_available`; one tap → response with
      `kind_hint: "fast_skip"` → next prompt (no grading UI, no
      self-grade).

**Acceptance:** manual — first run lets the user blow through known
material in one session (LEARNING-DESIGN §7); from session 2 the
button is gone and the queue sits at the user's frontier; a
fast-skipped item reappears only at `due_at = now + 30d` and is
excluded from reviews before then (`suspended = 1`).

**Notes:**

```
(started: · decided: · commits: )
```

---

## Milestone E — Phase acceptance

### P1.16 End-to-end acceptance pass

- [ ] Run the product-level definition of done against `npm run dev`
      on a desktop browser: open → one button → 10 min of graded
      prompts → saved → Done screen shows adapted preview → next
      session visibly adapted.
- [ ] `npm run check` green (lint + `wrangler types --check` +
      typecheck + tests).
- [ ] **Measure CPU/request** (D12's Phase 1 obligation): SM-2 +
      grading should sit at 1–5 ms; record the measurement in
      Notes. If any request approaches the 10 ms Workers Free
      budget, note it before considering Workers Paid.
- [ ] Phase 0 criteria unregressed: seed counts 8,334 / 2,091,
      `npm run seed && npm run dev` works, build/deploy path intact.

**Acceptance:** all boxes checked; the Phase 1 bullets in TASKS.md
are checked; no later-phase work started.

**Notes (include the CPU/request measurement):**

```
(started: · decided: · commits: · cpu/request: )
```

## Decisions

Settled while breaking down Phase 1 (changing any of these requires
updating this file together with the affected design docs, per
[AGENTS.md](../AGENTS.md)):

- **D-1 · fast-skip record.** `kind_hint: "fast_skip"` writes a
  `responses` row with `answer = NULL` and a new nullable
  `kind_hint` column (small Drizzle migration + DATA-MODEL.md /
  API.md sync in the same change), **plus** the `srs_state` row
  (`suspended = 1`, `due_at = now + 30d`). Bucket-accuracy queries
  count only rows where `kind_hint IS NULL`, so a skip is recorded
  (Done-screen counts, one idempotent endpoint) but never pollutes
  "graded responses" accuracy (LEARNING-DESIGN §3). *Rejected:*
  srs-only, no response row — simpler, but Done cannot distinguish
  skipped from abandoned prompts.
- **D-2 · prompt kinds in v1.** Recall kinds + vocab `production`
  (per TASKS.md's explicit "recall + production with self-grade"
  bullet and UX.md); no `passage_question` / writing-bank kinds
  until Phases 3–4. The phase header's "Recall prompts only" is
  read as "no content-piece prompts".
- **D-3 · streak day boundary.** Consecutive UTC calendar days with
  a `completed_at` session — consistent with "all timestamps UTC in
  storage"; revisit the local-display caveat at Phase 6 polish if
  it ever miscounts.
- **D-4 · partial keyword hit.** No complete keyword match but some
  token overlap between answer and expected keywords → `shaky`
  (LEARNING-DESIGN §1: "keyword matches that only partially hit").
- **D-5 · unknown-word capture.** The `kind_hint: "unknown_word"`
  branch is reserved in the contract but implemented in Phase 3 —
  there are no passages to capture words from in Phase 1.
- **D-6 · a lapse resets `reps` (P1.2).** `incorrect` sets
  `reps = 0` so the next `correct` re-enters the 1-day step and the
  item re-walks the 1 → 3 → mature ladder (Anki-style re-entry).
  Needed because §1's `round(previous × ease)` with
  `previous = 0` never recovers — a lapsed mature item would stay due
  forever, while `shaky` recovered via `max(1, 0 × 1.2)`; the gap
  was in the pseudocode. LEARNING-DESIGN §1 amended in the same
  change. *Rejected:* keeping lifetime `reps` and special-casing
  `interval = 0 → 1` on `correct` (recovery hidden in a branch;
  `reps` would mean "lifetime completions", which nothing reads);
  strict verbatim §1 (items frozen at interval 0).
- **D-7 · parentheticals in expected keywords (P1.3).**
  `expectedKeywords` drops balanced `(...)` groups *before* splitting
  on `;`/`,` — a parenthetical is a qualifier on a gloss, not an
  alternate answer (`toy` alone must not grade 風車 correct unless the
  answer contains `windmill`; `(book, magazine, etc.)` must not yield
  `etc`/`magazine`). Order matters: splitting first would cut commas
  inside the group (864 seed rows have one; 1 row nests parens).
  LEARNING-DESIGN §2's `(`…`)` clause amended in the same change.
  *Rejected:* the literal "split on `(`…`)`" reading — turns `etc`,
  `magazine`, `e.g. one's step` into standalone correct answers;
  keep-text-strip-brackets — yields `pinwheelttoy`, which matches
  neither `pinwheel` nor `toy`, failing legitimate answers.
- **D-8 · keyword matching = equality + contiguous token sequence (P1.4).**
  `keyword` grades `correct` only when the normalized answer equals an
  expected alternative (so a space-less `everymorning` still hits) or one
  side's token sequence contains the other's **contiguously, in either
  direction**; bare substring containment is rejected. Context: the
  P1.3 heads-up — 13 single-char keywords plus short ones like
  `in`/`or`/`me` under §2's either-way substring rule misgrade real
  answers (`thing` ⊃ `in`, `news` ⊃ `new`, `earth` ⊃ `art`), and a
  minimum-length floor would still leave every ≥3-char case broken.
  Consequences: LEARNING-DESIGN §2's keyword row amended in the same
  change; D-4's partial overlap is pinned as ≥1 shared token (no full
  match) → `shaky`, zero shared tokens → `incorrect`. *Rejected:*
  substring + length floor (fixes only ≤2-char keywords, keeps the rest);
  substring verbatim (keeps the misgrades, would defer a §2 amendment).

## Notes

- `streak_days` and `weakest_bucket` must share helper functions
  with the session builder (single implementation — see P1.8
  acceptance).
- Anti-requirements (LEARNING-DESIGN §9) apply verbatim to every
  sub-task here: no start/end ceremony, no config UI, no
  multiple-choice recall, no LLM in the prompt-serving path.
- Suggested first session: **P1.1 + P1.2** — the most self-contained
  slice (types + SM-2 kernel with its full grade-path test table).
- This file does not modify [TASKS.md](TASKS.md); when a sub-task
  lands, tick the corresponding Phase 1 bullet there too.





