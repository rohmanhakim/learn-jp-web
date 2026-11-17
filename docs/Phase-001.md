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

- [ ] Types shared everywhere: `Grade` (`correct|shaky|incorrect`),
      `Bucket` (`vocab_recog|kanji|reading|writing`), prompt kinds,
      self-grade (`solid|shaky|wrong`).
- [ ] Pure builders/validators for DATA-MODEL "Item keying" formats:
      `vocab:jlpt:n5:毎朝:meaning` · `…:reading` · `…:produce` ·
      `kanji:一:onkun`; and `prompt_key` formats per API.md
      (`r:jlpt:n5:毎朝:meaning`, `w:jlpt:n3:合図:produce`).

**Acceptance:** unit tests cover key round-trips and rejection of
malformed keys; types are importable by every later module without
pulling in DB or HTTP code.

**Notes:**

```
(started: · decided: · commits: )
```

### P1.2 SM-2 kernel — `src/worker/srs.ts`

- [ ] Pure function `applyGrade(state, grade, now) → next state`
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
(started: · decided: · commits: )
```

### P1.3 Text normalization + parity fixtures — `src/worker/normalize.ts`

- [ ] `normalizeExact`: NFKC → strip whitespace → katakana→hiragana
      (reading-answer path).
- [ ] `normalizeKeyword`: lowercase → NFKC → strip punctuation /
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
(started: · decided: · commits: )
```

### P1.4 Grading rules — `src/worker/grader.ts`

- [ ] `keyword` (recall/meaning): any expected keyword contained in
      the answer **or** vice versa → correct; partial token overlap
      only → `shaky` (decision D-4); none → incorrect.
- [ ] `normalized exact` (recall/reading, kanji_reading): equals any
      reading alternative after normalization.
- [ ] `production` merge matrix: checks pass + `solid` → correct;
      checks pass + `shaky` → shaky; checks fail **or** `wrong` →
      incorrect.
- [ ] Grading result carries the correct answer through for the
      inline "learning moment" display (UX: `✗ — correct was …`).

**Acceptance:** unit tests cover each rule (hit, miss,
multi-alternative, partial→shaky) and the full production merge
matrix; grader takes raw input + stored grading spec only (client
sends raw, server normalizes — UX.md).

**Notes:**

```
(started: · decided: · commits: )
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





