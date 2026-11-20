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
commits: (f296bf994844145948a677f6d1ecf301622da671 — `npm run check` 
green: 47 new tests in tests/keys.test.ts, 54 total) )
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
REAL and feed the mature formula (3.6 × 2.5 → 9) · commits: 
(c201d55bdad2527c217b4cb5ba1e43891d7a5899 — npm run check green: 16 
new tests in tests/srs.test.ts, 70 total) )
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
grader-side handling is deliberately out of P1.3's scope · commits: 
(8ea522fe2b79c96d403b9cfdba0599dfbaff0607 — npm run check green: 52 new 
tests in tests/normalize.test.ts, 122 total) )
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
commits: (fea6b558efc9fd19121ce1c2a84a040f8ce8bf6e — npm run check 
green: 25 new tests in tests/grader.test.ts, 147 total) )
```

---

## Milestone B — Prompting & session builder

### P1.5 Prompt factory — `src/worker/prompts.ts`

- [x] Vocabulary/kanji row → prompt object (`prompt_key`, `kind`,
      `bucket`, `is_new`, `instruction`, `stimulus`, `input`,
      `grading`) exactly in API.md shapes.
- [x] `kanji_reading` accepts on **or** kun reading when the word
      permits both (LEARNING-DESIGN §2).
- [x] `production` → `grading: { rule: "production", must_contain: [surface] }`.

**Acceptance:** golden-prompt tests for one vocab `meaning`, one
vocab `reading`, one `kanji_reading`, and one `production` prompt;
keys match P1.1 formats so the builder and `/api/responses` agree on
`prompt_key`/`item_key`.

**Notes:**

```
(started: 2026-11-17 · decided: (1) D-9 — wire `input` enum settled as
`text` | `text+selfgrade` | `choice`, exported as `PROMPT_INPUTS` from
prompts.ts so P1.7 derives one schema from it; API.md's line-59 comment
said `selfgrade+text`, contradicting its own worked example — example
wins, comment amended in the same change; (2) D-10 — recall/reading
cue = the raw EN `meaning`, VERBATIM (§2's primary "EN meaning → type
kana"; a cue is display text and never processed — the grading path
splits the gloss itself), keeping the two recall directions visually
distinct (JP vs EN stimulus); kanji_reading stimulus = the bare
character: §2's "(in word context)" is unreachable from a `kanji` row
(item key `kanji:一:onkun` is character-scoped, the table has no word
column), so a vocab join inside a pure factory was rejected — instead
alternatives = the full on+kun set with KANJIDIC okurigana markers
(`.`/`-`) stripped (`ひと.つ`→`ひとつ`, `ひと-`→`ひと`, `-うえ`→`うえ`;
verified over all 2,091 rows that those two are the ONLY non-kana
characters, and 0 rows become marker-only), i.e. "either family when
the word permits both" degenerates to "any reading of the character" —
lenient but never wrong-grade; LEARNING-DESIGN §2's kanji row amended
in the same change; (3) D-11 — production stimulus = `${surface}
(${first raw alternative})` → `合図 (sign)`; API.md's `合図 (signal)`
example was illustrative and is aligned to the rule; (4) API surface:
four factories `(row, { isNew }) → Prompt | null` with uniform
null-tolerance — reading nulls on missing/blank reading (2 seed rows:
jlpt:n1:伊井, jlpt:n2:一段と), meaning nulls when the gloss yields no
alternatives (0 rows), kanji nulls with neither family (0 rows);
production shares the signature (never nulls in practice); invalid
`level` THROWS (invariant break — seed validation guarantees n5..n1,
matching P1.1's builders) while null = content-driven skip the builder
filters; `is_new` always caller-supplied (a prompt never infers
recency); buckets: meaning/reading → vocab_recog, kanji → kanji,
production → writing (API.md example + UX mockup); grading specs
emitted RAW — meaning alternatives are `splitAlternatives(meaning)`
(D-7 paren-drop), readings keep stored katakana — P1.4 owns all
normalization — and always ≥1 entry (P1.4's vacuous-pass note); row
types are plain structural interfaces mirroring the Drizzle columns,
so prompts.ts stays DB-free and the builder passes rows straight in;
(5) seed cross-checks: readings single-valued (0 rows with `;`/`,`),
245 surfaces repeat across levels (harmless — prompt_key embeds the
level), 11 kanji lack on / 285 lack kun / 0 lack both · commits: (not
committed — 7b69d3bbfaf6ce71c6d0fc404eb0f96053fcdfdd - npm run check 
green: 17 new tests in tests/prompts.test.ts,
164 total) )
```

### P1.6 Session builder v1 — `src/worker/session-builder.ts`

- [x] Reviews: `srs_state` where `due_at ≤ now AND suspended = 0`,
      cap 25, oldest-due first (overflow rolls to next session).
- [x] New items: 3 drawn from the **weakest bucket** by 7-day
      rolling accuracy (buckets with no data = neutral, not
      weakest); kind mix follows the bucket (e.g. `kanji` →
      `kanji_reading` prompts, `writing` → production).
- [x] Level heuristic: lowest level where new items remain.
- [x] No content piece (LEARNING-DESIGN §4 rule 3 skipped in v1).
- [x] `adaptation_note`: one human sentence — what was focused on
      and why (API.md example style).
- [x] Emits the snapshot JSON for the `sessions.snapshot` column,
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
(started: 2026-11-17 · decided: (1) API surface: `buildSession(db, now: Date)`
plus exported `dueCount`, `bucketAccuracies`/`weakestBucket`, `streakDays` so
P1.8 reuses one implementation (Notes requirement above); raw `D1Database`
SQL per repo precedent (no runtime Drizzle query-builder yet), `now` injected
for deterministic tests; (2) snapshot = `{ prompts, passages: [],
adaptation_note, fast_skip_available }` — API.md `session/start` minus the
transport fields P1.9 adds, `passages` always [] in v1 (D-2);
(3) accuracy = `grade='correct'` numerator over all graded responses in a
7-day window (`shaky` counts in the denominator only), the window bound is
formatted as SQLite `datetime('now')` to match `created_at`'s column default;
ties break on `BUCKETS` declaration order; D-1's `AND kind_hint IS NULL`
filter is deferred to P1.10 (column does not exist yet) and flagged in a
header comment; (4) bucket kind mix: `kanji` → 3× `kanji_reading`, `writing`
→ 3× vocab `production`, `vocab_recog` → recall alternating
meaning→reading→meaning by slot (an exhausted direction retries the other
before leaving the bucket), `reading` → never actionable in v1 → fallback
order `vocab_recog → kanji → writing`; (5) level heuristic = first level in
`LEVELS` (n5→n1) with unseen items, per draw; unseen = no `srs_state` row
for that direction's `item_key` (correlated `NOT EXISTS` over
`'vocab:' || item_id || ':' || direction`); within-session draws are
distinct (vocab surfaces and kanji characters both excluded); (6)
`adaptation_note` always describes the bucket actually drawn, four
templates: weakest==drawn → API.md's exact `New items focus: kanji readings
(weakest 7d: 60%)` shape, plus no-history, reading-needs-passages and
exhausted-bank variants; (7) never-zero (D3): when every bank item is
seen+suspended a safety net draws with SRS ignored — tested via 4
`INSERT … SELECT` statements covering all directions; an unseeded DB stays
a Phase-0 invariant, not handled here; (8) `dueCount` is uncapped (the §4
cap is a composition rule, not a change in what is due); `streakDays` counts
UTC calendar days (D-3) back from today, yesterday still counts, 0 when the
latest session predates yesterday; (9) bug found by the tests: `drawBucket`'s
initial loop `i < NEW_ITEM_COUNT - prompts.length` compared an absolute index
against remaining capacity, stopping every call after 2 draws and yielding
4-item sessions — fixed to a `while (local < count)` capacity loop;
(10) tests: tests/session-builder.test.ts, 10 tests in workerd against
seeded D1 per seed.test.ts conventions, each test resets runtime tables
first so it passes under both per-test and per-file storage isolation ·
commits: e438afeac4a8ef1a9fbbcbc04642f22864fcfae3
```

---

## Milestone C — API & persistence

### P1.7 Shared API contract — `src/worker/api-types.ts`

- [x] Zod schemas for every request/response in API.md (status,
      session/start, responses batch + per-item results,
      session/complete), built with `@hono/zod-validator`.
- [x] Export `AppType` from the Hono app; PWA consumes it via
      `hc<AppType>`.

**Acceptance:** `npm run typecheck` proves request/response types
compile-time checked on both ends (D11); a contract test parses the
documented example payloads from API.md as valid; no duplicated
hand-written interfaces on the client.

**Notes:**

```
(started: 2026-11-19 · decided: (1) structure — schemas-first: api-types.ts
exports Zod schemas + inferred types for all four endpoints now, while
production routes stay unimplemented (P1.8–P1.11 own them); P1.7's
both-ends proof is a demo app built INSIDE tests/api-types.test.ts
(`zValidator` on all four routes, handlers returning the documented
payloads, consumed via `hc<typeof demoApp>`), so no stub handlers ship in
src/. (2) `export type AppType = typeof app` in index.ts — but routes must
be registered by CHAINING off the constructor: Phase 0's separate
`app.get(...)` statement left `typeof app` at hono's empty `BlankSchema`,
which made `hc<AppType>` resolve to `unknown`; the stub was rewritten as a
chained `.get()` and the requirement is documented in index.ts's header for
P1.8–P1.11. (3) enums derived, never re-spelled (D-9): grades/buckets/
prompt kinds from keys.ts, `input` from prompts.ts's PROMPT_INPUTS,
grading rules mirror GradingSpec; type assertions pin
`Equal<GradingSpec, GradingSpecWire>`, `Prompt extends PromptWire`,
`SessionSnapshot extends SessionSnapshotWire`. (4) wire optionality:
`is_new`/`stimulus`/`grading` are optional because API.md's passage
example omits them (passage questions grade by answer_index) — every v1
prompt sends all three; `passages[].level` stays a plain `string` to stay
assignable from the builder type until Phase 3 narrows it to LEVELS. (5)
response items are a 3-way union keyed by `kind_hint`: graded forbids it
(`z.undefined()` rejects the string), fast_skip (P1.15) and unknown_word
(D-5) require it; `self_grade` is required-but-nullable on graded items
(P1.4's note) and absent on the other two, `answer` optional on fast-skip
(one tap, nothing typed). (6) per-item results gained `correct_answer` +
`checks` — UX.md's learning moment and ✓/✗ line read them off the batch
response — and `interval_days` is non-negative but NOT integer, because
the shaky path yields e.g. 3.6 (§1); API.md amended in the same change.
(7) `session_uuid` is required in session/start: `sessions.client_uuid` is
`NOT NULL UNIQUE -- idempotency key from client` (DATA-MODEL); API.md's
"optional hints" line clarified to mean `max_minutes`. (8) API.md
amendments in this change: `fast_skip_available` on session/start,
`correct_answer`/`checks` on results, a documented fast-skip request
variant + the kind_hint exclusivity rule, first-run (`null`s) and
Phase-3 (`totals.passages`, `summary.reading/writing`) annotations, and
"preview must match what start serves". (9) `AppType` covers only the
Phase 0 stub until P1.8–P1.11 attach `zValidator` to each route — the
test's demo app proves full four-route inference today, and the
`SuccessJson` helper strips zValidator's own 400 (`ZodSafeParseError`)
branch that hono also hands the client. (10) zValidator's default failure
body is zod's error, not API.md's `{error:{code,message}}` envelope —
`errorSchema` exists in api-types.ts for P1.8+ to normalize into. (11)
tests: tests/api-types.test.ts, 35 tests = 14 documented-payload parses +
10 rejections + 2 domain-wire + 9 runtime zValidator/`hc` checks;
`npm run check` green: 209 total) · commits: f575c49db1ec10680e6db675287117363f4e8cea
```

### P1.8 `GET /api/status` (replace Phase 0 stub)

- [x] Real payload: `streak_days`, `last_session`, `due_count`,
      `totals`, `weakest_bucket`.
- [x] Streak computed from `sessions` (decision D-3 below).

**Acceptance:** tests for empty DB (first run), single session, and
multi-day streak; `due_count` matches the builder's due query;
`weakest_bucket` matches the builder's bucket computation (same
shared helpers, not a second implementation).

**Notes:**

```
(started: 2026-11-19 · decided: (1) structure — payload composition lives in
a new `src/worker/status.ts` (`statusPayload(db, now)`), so index.ts stays
route-registration-only and `now` is injectable (srs.ts / session-builder.ts
convention); the route injects `new Date()`. (2) Shared helpers, never a
second copy (Notes requirement above): `streakDays`, `dueCount`,
`bucketAccuracies` + `weakestBucket` are imported from session-builder.ts,
and the acceptance's parity bullets are asserted by comparing the served
body against those helpers' own output. (3) Status-only queries:
`last_session` = MAX(completed_at) over COMPLETED sessions (abandoned rows
keep NULL per DATA-MODEL "Retention & integrity" and never show as
activity — matches API.md's first-run note), `totals` = one scalar-subquery
row over vocabulary/kanji/passages (8334/2091/0; passages stays 0 until
Phase 3, D-2), live counts not seed constants. (4) GET has no request body,
so no zValidator: typing comes from `c.json<StatusResponse>`; the error path
returns API.md's envelope (errorSchema) with code `internal_error`, making
the client's decoded union `StatusResponse | {error: ApiError}` — pinned by
an `Equal` assertion (apparently the first production route on AppType; the
Phase 0 stub's `{ok}` shape is gone). (5) The 500 branch is type-checked
but not exercised at runtime — no way to force a D1 failure through the
public route. (6) Inherited caveat: `weakest_bucket` runs through
`bucketAccuracies`, which predates D-1's `kind_hint` column (P1.10 adds
`AND kind_hint IS NULL`) — status inherits that filter by construction;
flagged, not fixed. (7) Streak/due fixtures are built relative to
`Date.now()` because the handler owns its clock; coverage: empty DB first
run, single completed session + ignored abandoned row, 3-day consecutive
run, already-broken gap run (0), yesterday-still-counts (D-3), 3 due rows
vs suspended/future excluded, weakest-bucket parity, and one end-to-end
`hc<AppType>` call with a custom fetch back into the real app. (8) Live
smoke: `npm run dev` + `curl /api/status` served the API.md first-run body
verbatim. (9) tests: tests/status.test.ts, 8 tests in workerd against
seeded D1 per session-builder.test.ts conventions (seed once, runtime
tables wiped per test) · commits: 45e17dc89f1ccbca5ddda705f931bdb6a8d5d557
```

### P1.9 `POST /api/session/start`

- [x] Calls the builder; inserts `sessions` row (`client_uuid`,
      `started_at`, `snapshot`); response
      `title: "Session N · 10–15 min"`.

**Acceptance:** tests prove (a) fresh start persists the snapshot
verbatim, (b) replaying the same `session_uuid` returns the
**identical body** with no second row (UNIQUE + idempotency per
API.md), (c) the response parses as the `AppType` schema.

**Notes:**

```
(started: 2026-11-19 · decided: (1) idempotency reads BEFORE it builds —
the handler SELECTs `sessions` by `client_uuid` first and a replay answers
from the STORED snapshot (DATA-MODEL: "keeps exactly what was served"):
a fresh composition could differ (different `now` ⇒ different due set, and
`fast_skip_available` already flipped to false once a row exists); the
fresh path is one `INSERT … RETURNING id, snapshot` whose UNIQUE violation
(concurrent replay race) falls back to re-reading the stored row — same
body, never a second row. (2) `title` = `Session ${N} · 10–15 min` where N
is the row's ORDINAL (`COUNT(*) … WHERE id <= row.id`), not `COUNT(*)` at
response time — rows are never deleted (DATA-MODEL "Retention &
integrity"), so the ordinal is stable under replay and after later starts,
which is exactly what acceptance (b)'s "identical body" needs; abandoned
(uncompleted) sessions are rows and count too. The duration segment is a
literal: `max_minutes` is a hint the server may ignore (API.md) and
builder v1 has no time-based composition. `snapshot` is stored as
`JSON.stringify(snapshot)` verbatim and the response re-serves the parsed
snapshot — one source of truth, so stored and served cannot drift; a
corrupt stored snapshot fails the `sessionSnapshotSchema` parse and
surfaces as 500 rather than being silently recomposed. (3) validation
failures: zValidator's default 400 body is zod's error, NOT API.md's
`{error:{code,message}}` envelope (P1.7 Notes item 10) — a validator hook
on the route rewrites it to `code: "invalid_request"` with the first-issue
detail (`<path>: <message>; …`), so every branch `hc<AppType>` can decode
(200 / 400 / 500) follows the contract; `internal_error` keeps P1.8's
wording. This pins the error code for P1.10/P1.11. (4) `started_at` =
`now.toISOString()` (UTC ISO-8601, DATA-MODEL); the handler owns the real
clock (P1.8 precedent), `now` stays injectable for tests. (5) route
registered by chaining with `zValidator("json", sessionStartRequestSchema,
hook)` so it lands in `typeof app`/`AppType`; new module
`src/worker/session-start.ts` mirrors `status.ts`'s shape (payload
function + header comment, no HTTP in it) · tests:
tests/session-start.test.ts, 8 tests in workerd against seeded D1 per
status.test.ts conventions (seed once, runtime tables wiped per test):
verbatim persistence (stored snapshot ≡ served body minus transport
fields, ISO `started_at`, first-run `fast_skip_available`, never-zero
prompts, empty `passages`), replay ≡ original + single row, ordinal
numbering stable across later starts and replays, abandoned-row numbering,
both 400-envelope cases with no row written, one end-to-end
`hc<AppType>` call, plus compile-time `Equal` assertions (request type =
`SessionStartRequest`, client view = `SessionStartResponse | {error}`);
`npm run check` green: 225 total · live smoke: `npm run dev` + curl —
fresh start serves the API.md body, replay is byte-identical (`cmp`),
invalid body → 400 `invalid_request`, `/api/status` unregressed ·
commits: 2aa343842f9fc463740d09506534b3d68772fca8)
```

### P1.10 `POST /api/responses` (batch)

- [x] Per item: grade server-side (P1.4) → apply SM-2 (P1.2) →
      upsert `srs_state`, insert `responses` row.
- [x] Partially-successful semantics: per-item `results`, known
      `response_uuid`s reported `duplicate: true` (client drops
      them from its queue).
- [x] `kind_hint: "fast_skip"` → `srs_state` row with
      `suspended = 1, due_at = now + 30d` (LEARNING-DESIGN §1
      fast-skip) plus the summary-derivable record per decision
      D-1.
- [x] `kind_hint: "unknown_word"` → **deferred to Phase 3** (no
      passages exist yet); contract may reserve the field (D-5).

**Acceptance:** tests cover a mixed-grade batch updating SRS
correctly (including ease-floor and lapse paths exercised through
the endpoint, not just the kernel), replay → `duplicate: true` with
no double-count and no SRS re-application, the fast-skip path
creates a suspended row, and mid-batch duplicates are reported per
item while non-duplicates still land.

**Notes:**

```
(started: 2026-11-19 · decided:
(1) migration: D-1's `kind_hint` column AND `responses.grade` → nullable
    land in ONE Drizzle rebuild migration (0001_superb_black_tom) — a
    fast-skip/capture row has nothing graded, so `grade NULL ⇔ kind_hint
    set` (user decision; DATA-MODEL.md DDL synced in the same change).
    Repaired drizzle.config.ts `schema` to ./drizzle/schema/**/*.ts — it
    still pointed at drizzle/schema.ts, which commit 64ad7bd deleted.
(2) duplicate replay: stored `grade`, display fields (correct_answer /
    checks) RECOMPUTED from the snapshot spec + stored answer —
    gradeAnswer is pure, so output is byte-identical; a disagreement with
    the stored grade is corruption → 500. `srs` block reads the CURRENT
    srs_state row. Zero writes on replay (user decision).
(3) error split: the whole batch is validated (session, prompt_key ∈
    snapshot, item_key ≡ itemKeyFromPromptKey, kind_hint) BEFORE any
    write; violations throw InvalidRequestError → 400 invalid_request,
    everything else → 500 internal_error. So unknown session / foreign
    prompt / item_key mismatch / unknown_word (Phase 3, D-5) all leave
    zero rows (user decision; responseResultSchema has no per-item error
    field, so 400 is the only contract-expressible outcome).
(4) fast-skip = upsert: existing row keeps ease/interval/reps/lapses and
    only gets suspended=1 + due_at=now+30d; new row = initialSrsState +
    suspend (interval_days stays 0). The endpoint does NOT re-check
    fast_skip_available — the session row necessarily exists by answer
    time, so the gate lives in the P1.15 UI (user decision).
(5) per-item writes run in one db.batch each (D1 batches are
    transactional): the UUID claim and the SRS application commit
    together; a UNIQUE race re-selects and answers the duplicate path
    (P1.9 precedent).
(6) stored `bucket` and `srs_state.kind` come from the SERVED prompt,
    never the client echo — accuracy can't be poisoned by a bad client.
(7) retired the two deferrals: bucketAccuracies now carries
    `AND kind_hint IS NULL` (session-builder.ts header + status.ts
    inherited caveat rewritten) — a fast-skip counts in neither
    numerator nor denominator.
(8) tests: tests/responses.test.ts (7 tests, workerd). No content seed —
    grading reads a hand-built 4-prompt snapshot fixture, so grades and
    SM-2 expectations are exact. Heads-up for fixtures: the production
    prompt_key is `w:jlpt:n3:合図:produce` (5 segments).
commits: 34ec760a044cb0c981a3f213d9f7674e8d02839d)
```

### P1.11 `POST /api/session/complete`

- [x] Finalizes the session row (`completed_at`, `duration_sec`,
      `stats` JSON per DATA-MODEL "Session stats").
- [x] Response `summary`: reviews/new done+correct counts, streak.
- [x] `next_session.preview` + `note` derived from a **real builder
      projection** ("8 reviews · 3 new (kanji readings)" — no
      passage line in v1).

**Acceptance:** tests verify summary math against known responses,
preview counts match the actual next-start composition for the
post-session DB state, and completing an already-completed session
is idempotent (no stat inflation).

**Notes:**

```
(started: 2026-11-19 · decided:
(1) idempotency: the FIRST completion writes completed_at /
    duration_sec / stats once, via `UPDATE … WHERE completed_at IS NULL`
    (a racing replay loses the guard with 0 rows changed). The response
    body is RECOMPUTED on every call — counts derive from `responses`
    rows (derived data, never incremented), so no stat can inflate, and
    answers landing after completion (Phase 2's queue flushing) surface
    on the next call (UX.md: "the summary reflects everything once
    synced"). A replay with a different duration_sec sticks nothing.
(2) summary split: the STORED snapshot's `is_new` sides the responses
    joined on prompt_key. Fast-skip rows (D-1) count as DONE (the reason
    D-1 writes the row), never as correct (grade NULL), and never in
    stats accuracy (`kind_hint IS NULL` again, §3). prompt_keys outside
    the snapshot are ignored — defensive only, P1.10 rejects them at
    write time.
(3) streak via the shared `streakDays`, called AFTER the completion
    write so today counts (D-3); projection reuses `buildSession` +
    `bucketAccuracies`/`weakestBucket` — single implementation, no
    second copy (P1.8/P1.9 precedent).
(4) next_session.preview = a real projection: `buildSession(db, now)`
    re-run READ-ONLY against the post-session state (completion writes
    no SRS row), formatted `<N> reviews · <M> new (<bucketLabel>)`;
    zero segments omitted, `1 review` singularized (copy fix found by
    the live smoke — "1 reviews"), no passage line (D-2). The label is
    a new `bucketLabel()` export from session-builder, so builder and
    preview can never word a bucket differently; a mixed-bucket draw
    (only reachable via partial bucket exhaustion) drops the
    parenthetical.
(5) next_session.note = hybrid (user decision): full per-bucket
    WEAKNESS_SENTENCES when the projected draw is exactly the measured
    weakest bucket (so the sentence is true of what start will serve),
    otherwise the projection's own `adaptation_note`, whose templates
    already word the divergent cases (no history / reading weakest but
    passages later / bank exhaustion). Sentences are written per bucket
    rather than composed from labels — grammar differs ("…readings
    are" vs "…comprehension is").
(6) stats JSON per DATA-MODEL: `counts` as served (reviews/new only in
    v1 — reading/writing prompts don't exist, D-2), session-scoped
    `accuracy` over graded rows only (the 7-day rolling accuracy stays
    builder/status-owned), `buckets_practiced` in BUCKETS order. Written
    once at completion; audit-only — no route reads it back.
(7) errors: unknown session_uuid → InvalidRequestError → 400
    invalid_request BEFORE any write — the class is imported from
    responses.ts (one shared error type, not a second copy); schema
    failures go through the same zValidator hook as P1.9/P1.10; a
    corrupt stored snapshot surfaces as 500 (P1.9 precedent).
(8) tests: tests/session-complete.test.ts (9 tests, workerd, seeded D1
    per session-start.test.ts conventions): summary math against known
    fixture rows (fast-skip in done/not correct; stats accuracy 0.5 over
    4 graded rows), first-run adaptation_note fallback, preview ≡ a real
    follow-up session/start (counts + label, acceptance b), replay ≡
    original with duration 999 not sticking and rows unchanged at
    1 session / 0 responses (acceptance c), D-3 streak across a
    prior-day completion, both 400 paths (unknown uuid → no row; missing
    duration_sec → session left uncompleted), one end-to-end
    `hc<AppType>` call, compile-time Equal assertions (request =
    SessionCompleteRequest, client view = SessionCompleteResponse |
    {error}); `npm run check` green: 241 total (+9) · live smoke:
    `npm run dev` + script — start → responses (graded incorrect) →
    complete → preview `1 review · 3 new (word meanings & readings)`
    ≡ next start's real 1+3 composition with matching label, replay
    byte-identical, unknown uuid → 400 invalid_request envelope.
commits: d1998311d8e3ff48ec344f51b5e7bb05004356a8)
```

---

## Milestone D — Frontend (Svelte 5; Phase 1 target = desktop)

### P1.12 App shell + API client + Home

- [x] Minimal view switching Home → Session → Done (no router
      library; UX has exactly three screens).
- [x] `hc<AppType>` client module — the only place the app talks to
      the API.
- [x] Home per UX.md: streak, "Last: …", single **Start session**
      CTA; loading replaces the CTA label ("Preparing…"), never a
      spinner-only screen. (Offline CTA states are Phase 2.)

**Acceptance:** manual — one tap from open to prompt 1 on local dev
stays within the ≤5 s tap-to-first-prompt metric; no screen sits
between open and the first prompt (UX hard rule).

**Notes:**

```
(started: 2026-11-19 · decided:
(1) "Last:" line — status.last_session is a timestamp only, so UX.md's
    "· 12 min" clause has no contract data: Home shows the relative day
    alone ("Last: yesterday") on D-3's UTC calendar-day basis.
    Extending the status payload with a duration was rejected (API.md +
    contract + status-test churn for a "glanceable, not interactive"
    line) — revisit only if it ever reads wrong.
(2) structure — src/client/api.ts is the ONLY API touchpoint
    (hc<AppType>(""), same-origin): fetchStatus + startSession unwrap
    API.md's {error:{code,message}} envelope into a thrown ApiError, so
    each screen handles failure with one try/catch. AppType and the
    contract types are type-only imports (verbatimModuleSyntax erases
    them) — no worker runtime code enters the client bundle; only
    hono/client ships. The `Contract | {error}` casts are safe because
    tests/*.test.ts already pin all four client views to the contract
    with Equal assertions.
(3) shell — App.svelte owns one view rune (home | session | done, no
    router per the plan) plus the session snapshot; Home owns the
    status fetch and the CTA; Session.svelte and the Done branch are
    placeholders P1.13/P1.14 fully replace (the Session stub renders
    only title, 1/N, first stimulus/instruction so the ≤5 s acceptance
    can land on prompt 1 — its "reload to return home" hint is
    temporary and leaves with the stub).
(4) CTA rules — status loads in the background so the CTA never waits
    on it; status failure degrades silently (no streak/Last lines, CTA
    live); while start is in flight the label becomes "Preparing…"
    (UX.md: never a spinner-only screen); start failure shows one
    muted aria-live line under the CTA. Offline CTA states are
    deliberately absent (Phase 2).
(5) verification — `npm run check` green (241 total) and `npm run
    build` clean; live smoke against `npm run dev`: GET / → 200,
    GET /api/status served the contract body, POST session/start
    returned the snapshot, same-uuid replay byte-identical, bad uuid →
    400 invalid_request envelope (surfaced by the UI as the muted CTA
    error line). tsc does not look inside .svelte files (Phase 0's
    minimal toolchain) — the components are covered by the vite build
    plus this manual pass; the eyeball check of tap → prompt 1 ≤ 5 s
    in a desktop browser is the one manual acceptance step.
commits: 6d65d9994ec04ec88c30fd237b4e6343f567ee82)
```

### P1.13 Session screen

- [x] One prompt at a time; slim header `n/total · progress · ✕`
      (exit = confirm → partial session saved → Done-lite).
- [x] Recall: text input, ⏎ submit → inline verdict ~1.2 s → next;
      **wrong shows the correct answer** inline.
- [x] Production: textarea + self-grade `✓ solid / ~ shaky / ✗ wrong`
      appearing only after submit; desktop shortcuts `1/2/3`;
      deterministic check feedback (`✓ contains 合図`) shows
      regardless of self-grade.

**Acceptance:** manual walkthrough of a recall flow and a
production flow matching the UX.md mockups; exit mid-session keeps
partial responses (they count toward the Done summary); no network
block on showing the next prompt.

**Notes:**

```
(started: 2026-11-19 · decided:
(1) production check feedback — grading needs the self-grade, which does
    not exist until the next tap, so /api/responses cannot produce the
    ✓/✗ contains line at submit time. The line shown after submit is a
    LOCAL display-only preview computed with the SAME formula as
    grader.ts (normalizeExact is a pure zero-import module, imported
    client-side, so parity holds by construction). The response is sent
    ONCE, after the self-grade tap; the final verdict renders the
    SERVER's `checks` + `grade`. Server stays authoritative (§2).
(2) exit — native window.confirm() (one dialog, no ceremony) → await the
    in-flight /api/responses promise → POST /session/complete with
    duration_sec from screen entry → oncomplete(result). Counts derive
    from `responses` rows, so partial exits count (verified live:
    complete after one answer → reviews {done: 1}). Nuance: an answer
    still at the self-grade step when ✕ is pressed was never sent (the
    contract requires self_grade), so it is not counted. If the complete
    call fails, oncomplete(null) reaches App — P1.14 owns that view.
(3) network policy — the next prompt ALWAYS renders from the in-memory
    snapshot; the verdict races the single /api/responses call against a
    1.2 s window whose timer starts AT SUBMIT, so a hung call cannot
    block advancing (late results only paint while their window is open,
    guarded by index + phase). Failures are console-logged only; Phase
    2's queue replaces this wholesale. Blank answers blocked client-side.
(4) structure — src/client/api.ts gains sendResponses + completeSession
    (same unwrap pattern); Session.svelte is a 3-phase state machine
    (answering → checks → verdict) holding one prompt in memory; item_key
    is derived client-side via itemKeyFromPromptKey (pure keys.ts — the
    P1.12 type-only rule targets Hono/D1 runtime; verified live:
    r:jlpt:n5:時間:meaning → vocab:jlpt:n5:時間:meaning). App.svelte
    stores `completed`; the done branch is now a working Done-lite (real
    answered count + streak + next preview + a Done button home — UX.md's
    exit → Done-lite summary); P1.14 replaces it wholesale.
(5) copy/interaction — chip labels are short nouns (BUCKET_SHORT:
    vocab_recog→vocab) because session-builder's bucketLabel is sentence
    copy; the production line = instruction + gloss sliced off `stimulus`
    after must_contain[0] (matches UX.md "…using 合図 (signal)"); recall
    renders stimulus above instruction (mock order), production only the
    combined line; ⏎/Enter is IME-guarded (e.isComposing), Shift+Enter
    is the textarea newline escape; self-grade shortcuts 1/2/3 bind on
    window while phase=checks — the field is blurred on submit so digits
    never enter the answer; verdict copy per UX.md (✓ correct / ~ shaky /
    ✗ — correct was X; production failures read via the checks line) in
    a persistent role=status aria-live=polite line; latency_ms =
    shownAt → submit; fields are readonly outside `answering`.
(6) verification — npm run check green (lint + wrangler types --check +
    tsc + 241 tests); vite build clean (fixed one state_referenced_
    locally warning: total → $derived); live dev smoke: status → start
    (4 prompts) → responses (grade incorrect, correct_answer "time;
    hour; period; class", srs interval 0) → complete (summary + real
    preview) → status updated, GET / → 200. NOT yet done: the human
    eyeball walkthrough against UX.md's mockups (recall + production +
    exit mid-session + ≤5 s tap-to-first-prompt) — the three checkboxes
    stay unticked until that pass.
(7) reachability finding (2026-11-19) — production prompts (the ONLY
    kind carrying the self-grade row) cannot occur in a normal run: the
    builder draws weakest-bucket-first then fallback
    `vocab_recog → kanji → writing`, each bucket filling all 3 new
    slots, while `weakestBucket` skips neutral buckets (no graded rows
    in 7d). Only vocab_recog ever accumulates rows — it draws first and
    reviews are its recall prompts — so kanji/writing stay neutral
    forever and are never drawn. Chicken-and-egg: self-grade UI is
    built but unreachable through play (the §4 rule-3 content-piece
    writing prompt is Phase 4; D-2 skips content in v1). DECISION:
    accept for Phase 1 (option 1); changing the draw rule would amend
    LEARNING-DESIGN §4/§5 + this plan together — deferred as an
    explicit product decision (see the general Notes bullet).
(8) production verified by FORCING writing weakest on local D1 —
    `INSERT INTO responses (session_id, client_uuid, prompt_key,
    item_key, answer, grade, self_grade, bucket) SELECT id,
    lower(hex(randomblob(16))), 'w:jlpt:n5:合図:produce',
    'vocab:jlpt:n5:合図:produce', 'x', 'incorrect', 'wrong', 'writing'
    FROM sessions ORDER BY id DESC LIMIT 3;` (remove with `DELETE FROM
    responses WHERE bucket='writing' AND kind_hint IS NULL;` — these 3
    rows are still in the local dev DB so the browser walkthrough can
    see the production UI). Results: status.weakest_bucket → writing;
    session/start → 4 due recall + 3 production prompts
    (`Write a sentence using 鉛筆 (pencil)`, input=text+selfgrade,
    rule=production, must_contain=[surface]); contract round-trip:
    token present + solid → grade correct, checks [{鉛筆,true}], srs
    1d; token absent + shaky → grade incorrect, checks [{時間,false}]
    (checks dominate the self-grade, per §2's merge); production rows
    re-enter the next session as due reviews (interval 0) with the
    `review · writing` chip. Session.svelte SSR render with a
    production snapshot prints `1/1 ✕ · review · writing · Write a
    sentence using 鉛筆 (pencil) · <textarea>` and correctly NO
    self-grade row while phase=answering — the ✓/✗ row needs the submit
    tap and is therefore the one part still owed to the human browser
    pass in (6).
(9) walkthrough PASSED 2026-11-19 (user, desktop browser) — recall
    inline verdict, production submit → checks line → self-grade row +
    1/2/3 shortcuts → verdict, ✕ mid-session → partial counts on Done,
    last prompt → Done directly (never via Home), preview ≡ the next
    start's composition, ≤5 s tap-to-first-prompt. All three boxes
    ticked; TASKS.md's Frontend bullet ticked alongside.
commits: 86ea4c791c25eab1ef42b3bff292f1abccea13d2 )
```

### P1.14 Done screen

- [x] Summary counts, streak, `next_session.preview` + adaptation
      note, single **Done** button → Home.
- [x] After the last prompt, the Session screen is replaced by Done —
      never routed back through Home in between.

**Acceptance:** manual — Done reflects the completed session's real
data (no placeholders), and the preview sentence matches what the
next `session/start` actually serves.

**Notes:**

```
(started: 2026-11-19 · decided:
(1) structure — new src/client/Done.svelte (props: `completed:
    SessionCompleteResponse | null`, `ondone`); App.svelte's done branch
    is now one <Done> element and the Done-lite markup/styles are gone
    (App keeps only the :global(body) rules it shares with every view).
    No new api.ts call — `completeSession` exists since P1.13 and the
    payload already reaches App as `completed`.
(2) data — EXACTLY the /session/complete payload: counts are the
    server's `responses`-row projection (so a mid-session exit counts,
    P1.13 decision 2) and preview/note are P1.11's real projection —
    zero client-side math, no second fetch, no placeholders.
(3) rows — `correct/done` per the mockup ("reviews 8/9", "new words
    2/3"); `reading` ("3/3 + 2 saved") and `writing` ("solid") render
    ONLY when their optional summary fields arrive, so Phases 3–4 light
    up with zero edits. Streak line shows only when > 0 (Home's rule;
    the mockup's 🔥 5-day is the >0 case).
(4) degraded case — `completed === null` (complete call failed) renders
    heading + one muted aria-live line + the Done button: no invented
    numbers, no Next block (neither exists without the payload).
(5) verification — `npm run check` green (lint + wrangler types --check
    + tsc + 241 tests) and `vite build` clean. Live API smoke against
    `npm run dev`: status → start (4 prompts) → responses (grade
    correct, srs interval 1d) → complete → summary {reviews 1/1,
    streak 1} + preview "3 new (word meanings & readings)" ≡ the
    follow-up session/start composition (0 reviews — a zero segment is
    omitted by P1.11's format rule). Component markup verified WITHOUT a
    browser (none available in this environment) by rendering
    Done.svelte through vite SSR + `svelte/server`: real payload prints
    exactly the UX.md mockup lines (Session complete · reviews 8/9 ·
    new words 2/3 · 🔥 5-day streak · Next: … · note · Done), a Phase
    3/4 payload adds the reading/writing rows and hides a 0-day streak,
    and the null payload contains no digits and no Next line. Drive-by
    fix: App.svelte's contract import pointed at ./worker/api-types
    (nonexistent from src/client — it only survived because the import
    is type-only and erased; tsc does not read .svelte files) →
    ../worker/api-types, matching Session.svelte.
NOT yet done: the human browser walkthrough — Done must be eyeballed
against the UX.md mockup with a real session, TOGETHER with P1.13's
still-outstanding recall/production/exit pass (both checkboxes stay
[~] until then). TASKS.md's "Done screen shows next_session.preview"
bullet stays unticked for the same reason.
(6) walkthrough PASSED 2026-11-19 (user, desktop browser) — real
    counts/streak/preview/note on Done after both the last-prompt and
    the exit path, Next line ≡ the following session/start's actual
    composition, single Done button back to a refreshed Home.
    TASKS.md's "Done screen shows next_session.preview" bullet ticked
    with it. Both checkboxes above are [x].
commits: bb1fa234c28eb405f1b3bebf21b05ec68dbade2b )
```

### P1.15 First-run fast-skip UI ("I know this")

- [x] "I know this" action on every recall prompt when the snapshot
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
(started: 2026-11-20 · decided:
(1) UI gate — one derived `canSkip` in Session.svelte: snapshot's
    `fast_skip_available` && recall prompt (!isProduction) && phase
    answering. The server deliberately does NOT re-check the flag
    (responses.ts comment): by the time answers arrive the session row
    exists, so the gate is the UI's alone.
(2) send path — a dedicated `fastSkip()` beside gradeAndAdvance, NOT a
    reuse: no verdict phase, no 1.2 s window — `advance()` runs
    synchronously (the tap IS the advance, UX.md "no network block").
    The send joins `inflight`, so last-prompt and ✕-exit still await
    the skip row before /session/complete computes counts. Failures are
    console-logged only (Phase 2's queue owns retry/offline).
(3) double-tap guard — 300 ms window via a `lastSkipAt` stamp:
    advance() swaps in the NEXT prompt's enabled button synchronously,
    so a second click in the same burst would otherwise skip twice.
(4) placement — muted ghost button (`.skip`) under the answer field,
    never on production prompts, no keyboard shortcut (one-tap, §9).
    UX.md had no fast-skip mockup — §2 gained a short "First-run
    fast-skip" paragraph documenting the button in the same change.
(5) verification — `npm run check` green (lint + wrangler types
    --check + tsc + 241 tests) and `vite build` clean. Live API smoke
    against `npm run dev` on a RESET local D1 (rm .wrangler/state/v3/d1
    → db:apply → seed 8,334/2,091): start #1 → fast_skip_available
    true, 3 prompts → fast-skip request (the exact Session.svelte
    payload) → 200 with `{duplicate, srs}` only (NO grade /
    correct_answer / checks), due_at = now + 30.00d → complete →
    summary new {done: 1, correct: 0} (counted, never correct) →
    start #2 → flag false AND the skipped item (r:jlpt:n5:大人:meaning)
    absent from prompts → status due_count 0 (suspended excluded) and
    weakest_bucket still null (kind_hint excluded from §3 accuracy) →
    D1 rows: responses kind_hint='fast_skip' with answer/grade/
    self_grade NULL; srs_state suspended=1, due_at exactly +30d →
    reappearance: unsuspend + backdate → the item returns as a REVIEW
    (is_new false). DB reset to first-run (sessions/responses/srs_state
    = 0) after the smoke so the browser pass starts fresh.
NOT yet done: the human browser pass — eyeball that the button renders
on every recall prompt of session 1, one tap advances with no grading
UI, and it is gone from session 2 (checkbox stays [~] and TASKS.md's
Fast-skip bullet stays unticked until that pass — P1.13/P1.14
precedent).
(6) walkthrough PASSED 2026-11-20 (user, desktop browser) — localhost:
    "I know this" appears on session 1's recall prompts, tapping it
    through to the end of the session works, and session 2's start
    serves no button (flag false). Checkbox → [x]; TASKS.md's
    First-run fast-skip bullet ticked alongside.
commits: 8e33a3a3d15523012e7fe13aed25db3e2874e87b)
```

---

## Milestone E — Phase acceptance

### P1.16 End-to-end acceptance pass

- [x] Run the product-level definition of done against `npm run dev`
      on a desktop browser: open → one button → 10 min of graded
      prompts → saved → Done screen shows adapted preview → next
      session visibly adapted.
- [x] `npm run check` green (lint + `wrangler types --check` +
      typecheck + tests).
- [x] **Measure CPU/request** (D12's Phase 1 obligation): SM-2 +
      grading should sit at 1–5 ms; record the measurement in
      Notes. If any request approaches the 10 ms Workers Free
      budget, note it before considering Workers Paid.
- [x] Phase 0 criteria unregressed: seed counts 8,334 / 2,091,
      `npm run seed && npm run dev` works, build/deploy path intact.

**Acceptance:** all boxes checked; the Phase 1 bullets in TASKS.md
are checked; no later-phase work started.

**Notes (include the CPU/request measurement):**

```
(started: 2026-11-20 · decided: (1) clean-room via a RUNTIME-TABLE reset,
NOT a reseed — `DELETE FROM sessions; responses; srs_state;` (content
tables untouched, 8,334/2,091 verified by count) after P1.15's walkthrough
left an abandoned session row, 3 suspended fast-skip items and an inflated
session ordinal; note `npm run seed` could not have done it (upsert-only,
zero DELETE statements), so a reseed is the wrong tool for clearing
progress. (2) "10 min of graded prompts" is read as PHASE-1 SCOPE, not
literal wall time: builder v1 serves 3 new + due reviews only, so one run
is 3–5 prompts and under a minute (measured 41 s / 26 s). Duration is a
Phase 3–4 consequence of content depth; recorded here so a later session
does not read the short run as a miss. (3) cpu/request measured TWO ways
because local workerd exposes no CPU timer — an in-process micro-benchmark
of the pure domain (the CPU a Worker actually burns on SM-2 + grading; D1
wait is I/O and excluded by definition) plus full-request wall clock
through Vite → workerd → local SQLite as an upper bound.
· walkthrough PASSED 2026-11-20 (user, desktop browser, localhost). Session
1 (41 s): 0/3 new words + 1 first-run fast-skip (the P1.15 button, present
session 1 only), Done → `Next: 2 reviews · 3 new (word meanings &
readings)` + weakness sentence + 🔥 1-day streak. Session 2 (26 s): served
EXACTLY 2 reviews + 3 new — the two items missed in session 1 came back as
`review` chips — 1/2 reviews, 1/3 new, `Next: 3 reviews · 3 new`. After it
`GET /api/status` → due_count 3 (≡ the preview), weakest_bucket
vocab_recog (was null on first run), streak_days 1. Independent parity
check: a scripted `session/start` returned 3 `is_new:false` + 3
`is_new:true` prompts ≡ that Done preview, adaptation_note "New items
focus: word meanings & readings (weakest 7d: 29%)". D1 rows back all of it:
srs_state intervals 0 → due now, 1 → due +1d, fast-skip → +30d suspended.
· Phase 0 unregressed: `npm run seed` → "✅ local seeded: 8334 vocabulary /
2091 kanji, no duplicate item_ids"; `npm run build` clean (192 ms);
`npm run check` → 241 tests / 12 files green (lint + wrangler types
--check + tsc).
· cleanup: the parity check's own start wrote one abandoned session row
(no responses, never completed) — deleted again afterwards, so the local
DB holds only the 2 walkthrough sessions and the next start ordinals as
"Session 3".
commits: · cpu/request: pure domain, 200k iterations — gradeAnswer 0.76–
3.75 µs/call (keyword correct 1.40, keyword wrong 3.75, normalized_exact
0.76, production 1.32), applyGrade 0.60–0.64 µs/call → 0.001–0.004 ms per
call, ~3 orders of magnitude under D12's 1–5 ms expectation and nowhere
near the 10 ms Workers Free budget. Full-request wall clock (dev, UPPER
BOUND incl. proxy + workerd + local SQLite): status 15.4–30.3 ms (median
21), session/start fresh 26.6 ms / replay 15.1 ms, responses batch of 3
graded 26.3 ms, session/complete 24.4 ms. No request approaches 10 ms of
CPU; a literal production CPU/request figure needs Workers Observability
after a deploy (open follow-up, not a Phase 1 blocker).
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
- **D-9 · wire `input` spelling (P1.5).** The enum is `text` |
  `text+selfgrade` | `choice`, exported from `prompts.ts` as
  `PROMPT_INPUTS` so P1.7 derives one schema from it and no second
  spelling exists anywhere. Context: API.md's line-59 comment said
  `selfgrade+text` while its own worked example (line 69) and the UX
  copy say `text+selfgrade`. *Rejected:* following the comment — it
  would have forced the example, the mockups, and this file to change.
- **D-10 · recall/reading cue = raw EN meaning; kanji_reading
  stimulus = bare character (P1.5).** §2 allows either cue for
  `recall/reading` ("EN meaning (or JP word+hint)"); the EN gloss is
  its primary wording, keeps the two recall directions visually
  distinct (JP vs EN stimulus), and is emitted VERBATIM — a cue is
  display text, never processed; the grading path splits the gloss
  itself. For `kanji_reading`, §2's "(in word context)" is
  unreachable from a `kanji` row: `item_key` is character-scoped
  (`kanji:一:onkun`) and the table has no word column, so the
  stimulus is the bare character and the alternatives are the full
  on+kun set with KANJIDIC okurigana markers (`.`/`-`) stripped —
  the only non-kana characters across all 2,091 seed rows, so no
  reading becomes marker-only. Consequences: LEARNING-DESIGN §2's
  kanji_reading row amended in the same change; "accept on or kun
  when the word permits both" becomes "any reading of the character"
  (lenient, never wrong-grade; exact-match still applies per
  alternative). *Rejected:* JP-surface reading cue (allowed by §2,
  but the EN cue is primary and disambiguates the two recall
  directions); word-context stimulus via a vocab join (DB dependency
  inside a pure module; the stimulus would vary for a
  character-scoped item while the graded identity stays fixed).
- **D-11 · production stimulus = `surface (first alternative)`
  (P1.5).** `${content} (${splitAlternatives(meaning)[0]})`, e.g.
  `合図 (sign)`; bare surface when the gloss yields no alternatives.
  API.md's `合図 (signal)` example was illustrative and is aligned to
  the rule in the same change. *Rejected:* the raw full gloss inline —
  2,844 seed meanings contain parentheses and the cue would drown the
  prompt.

## Notes

- `streak_days` and `weakest_bucket` must share helper functions
  with the session builder (single implementation — see P1.8
  acceptance).
- Anti-requirements (LEARNING-DESIGN §9) apply verbatim to every
  sub-task here: no start/end ceremony, no config UI, no
  multiple-choice recall, no LLM in the prompt-serving path.
- **Open product decision (found 2026-11-19, P1.13 Notes 7):**
  production / self-grade prompts are unreachable in normal play —
  `weakestBucket` skips neutral buckets, so `writing` (and `kanji`)
  can never be drawn first, and `vocab_recog` fills all 3 new-item
  slots. Phase 1 accepts this; making production practice appear
  without history would need a draw-rule change (rotation, or neutral
  buckets eligible), which must amend LEARNING-DESIGN §4/§5 and this
  plan together. Until then the self-grade UI is exercised only by
  forcing `writing` weakest (P1.13 Notes 8) or arrives with Phase 4's
  content-piece writing prompt (§4 rule 3).
- Suggested first session: **P1.1 + P1.2** — the most self-contained
  slice (types + SM-2 kernel with its full grade-path test table).
- This file does not modify [TASKS.md](TASKS.md); when a sub-task
  lands, tick the corresponding Phase 1 bullet there too.





