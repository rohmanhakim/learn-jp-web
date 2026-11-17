# Task Plan

Phased plan from empty repo to a fully usable loop. Each phase ends in
a demonstrable state; later phases must not regress earlier acceptance
criteria. **No code exists yet — Phase 0 is the first development
session.**

## Definition of done (product-level)

> Open app → one button → 10 min of graded prompts → performance saved
> → next session visibly adapted → repeat,
> on phone **and** laptop, with connectivity optional.

Metric to protect at every phase: **tap-to-first-prompt ≤ 5 s, zero
manual setup.**

---

## Phase 0 — Repository & data foundation

Setup only; no user-facing behavior.

- [x] Project scaffold: Svelte+Vite PWA + Cloudflare Worker (Hono) in
      one repo with `@cloudflare/vite-plugin`, shared scripts
      (`dev`, `test`, `seed`, `build`, `deploy`)
- [x] Schema via Drizzle per DATA-MODEL.md + `schema_version`/
      `seed_hash` in `user_config`; migrations applied with
      `wrangler d1 migrations apply` (local + remote)
- [x] Seed importer: `data/seed/vocabulary.json` + `kanji.json` →
      idempotent literal-value `seed.sql`, applied with
      `wrangler d1 execute --file` (verify counts 8,334 / 2,091)
- [x] Import unit tests (counts, uniqueness of item_id, level tags
      valid) in Vitest via `@cloudflare/vitest-plugin` (runs in workerd)
- [x] `vite build` + `wrangler deploy` serves an (empty) page;
      `wrangler types` generates `Env` and is wired into `tsc`
- [x] One-time manual: Cloudflare account/zone + D1 database + Access
      application on the hostname (One-time PIN, single email) before
      the first deploy — the app is never reachable without a gate (D8)
- [x] CI or pre-commit: lint + `wrangler types --check` + tests (pick
      one, keep minimal)

**Acceptance:** `npm run seed && npm run dev` yields a running dev
server (workerd + local D1) with seeded DB; `npm run deploy` serves an
(empty) page behind Access.

## Phase 1 — The core loop (MVP)

Recall prompts only — the loop itself must exist before content depth.

- [x] SM-2 kernel (`srs` module) with unit tests for every grade path
      (first rep, second rep, mature, lapse, ease floor)
- [ ] Grading rules: `keyword`, `normalized exact` (+ NFKC, kana
      normalization) with normalization unit tests; parity fixture
      table with hardcoded expected outputs (guards the one TS
      portability risk flagged in D11)
- [ ] Session builder v1: due reviews + 3 new items (no content piece
      yet) + `adaptation_note`
- [ ] Endpoints: `POST /api/session/start`, `POST /api/responses`
      (batch, UUID-idempotent), `POST /api/session/complete`,
      `GET /api/status`
- [ ] Shared API contract: export Hono `AppType`; the PWA consumes it
      via `hono/client` (`hc<AppType>`) so request/response types are
      compile-time checked on both ends
- [ ] Frontend: Home / Session / Done per UX.md (recall + production
      with self-grade)
- [ ] First-run fast-skip ("I know this") flow
- [ ] Sessions + responses persisted; streak computed from `sessions`
- [ ] Done screen shows `next_session.preview` derived from real data

**Acceptance:** complete the product-level definition of done against
the local dev server, desktop browser. No external services, no third-party
      integrations, no LLM.

## Phase 2 — Offline-first (PWA)

- [ ] Service worker: precache app shell; app boots offline
- [ ] IndexedDB: snapshot + answer queue (client_uuid per response)
- [ ] Offline paths per UX.md interaction-state table (queued badges,
      resume after kill, exit-mid-session partial save)
- [ ] Sync flush on reconnect with partial-success handling
      (`duplicate: true`), server UNIQUE constraints tested
- [ ] Service worker coexists with the Cloudflare Access session
      redirect: first visit authenticates via Access, the app still
      boots offline from precache afterwards
- [ ] Lighthouse PWA checks: installable, offline-capable, score ≥ 90

**Acceptance:** airplane-mode session on a phone completes end-to-end
and its data appears in the DB after reconnect; replaying the queue
double-counts nothing.

## Phase 3 — Reading

- [ ] Content pipeline tooling (dev-time, Node/TS): batch generate →
      validate → human-curate → export `data/seed/passages.json`;
      calls go through the provider-neutral `LLMClient` seam (V1:
      Workers AI REST endpoint)
- [ ] Initial bank: ~30 passages with 1–3 questions each (levels
      n5–n4 first; grow later)
- [ ] Importer + schema for `passages` / `passage_questions`
- [ ] Known-word-ratio estimator + passage selection rule
      (≥85% target) with tests
- [ ] Session builder v2: inserts one passage per session when bank
      exists
- [ ] UX: passage display, choice questions, tap-to-capture unknown
      word → `unknown_words` table (vocabulary resolution included)
- [ ] Queued unknown words surface as `recall/reading` prompts

**Acceptance:** sessions now alternate reading content; captured words
reappear as review prompts in a later session.

## Phase 4 — Writing

- [ ] Content pipeline: `data/seed/writing_prompts.json` bank
      (prompt + model answer + required tokens), initial ~50 items
      n5–n3
- [ ] Grading: deterministic checks (must-contain, required tokens,
      min length) merged with self-grade per LEARNING-DESIGN §2
- [ ] Session builder v3: writing prompts from the weakest productive
      bucket
- [ ] Done screen reports writing verdict (`solid`/`shaky`/`wrong`)

**Acceptance:** writing prompts appear regularly; verdicts are stored
and feed bucket accuracy.

## Phase 5 — Adaptation quality (optional LLM evaluation)

- [ ] Per-bucket rolling accuracy (7-day) implemented and unit-tested
      (this likely exists earlier — formalize now)
- [ ] Bucket-driven new-item kind selection + weakening/rot-floor rules
      (LEARNING-DESIGN §5) behind config flags
- [ ] `LLMClient` seam (provider-neutral, Zod-validated outputs) with
      the V1 Workers AI implementation; model id from config, never
      from call sites
- [ ] Async LLM evaluator for free-form writing: queue producer after
      `session/complete`, queue consumer writes `writing_evaluations`
      (idempotent on `response_uuid`, retries + dead-letter queue);
      **never** blocks or mutates session records; fully optional
      (feature-flagged, works when disabled)
- [ ] `adaptation_note` text derived from real signals

**Acceptance:** two consecutive weeks of sessions show composition
shifting toward measured weaknesses; app remains fully functional with
the LLM feature off.

## Phase 5.5 — Personalized story pool (D13)

Requires Phase 3 (passages machinery + validator) and Phase 5 (LLM
seam). Grows the pool *between* sessions — never at serve time.

- [ ] Mastery profile builder: known set (mature SRS items) + frontier
      targets (weakest bucket) + level via the ≥85% gate + genre
      rotation → `profile_hash`
- [ ] `story-gen` queue producer at `session/complete` (when the pool
      lacks a usable story) plus a `scheduled()` top-up; consumer calls
      `LLMClient` with a strict JSON schema
- [ ] Shared deterministic validator (same checks as the seed
      pipeline): vocab constraint, known-word ratio band,
      `answer_index` in range → `status`
      selectable/quarantined/rejected; `profile_hash` dedup
- [ ] Builder prefers a `selectable` story matching the current
      profile; falls back to the curated seed passage (never a dead
      end, D3)
- [ ] Feedback demotion: repeated bad comprehension outcomes
      quarantine a story (no UI — pure signal)
- [ ] Tests: validator fixtures, double-delivery idempotency, and
      "feature off / queue down ⇒ byte-identical to Phase 3" behavior

**Acceptance:** with the flag on, the session after a profile change
serves a validated story generated for the current mastery profile;
with it off or the provider down, sessions behave exactly as Phase 3.

## Phase 6 — Polish & deployment

- [ ] Mobile pass: typography, tap targets, IME quirks (composition
      events must not submit mid-IME)
- [ ] Light/dark, `aria-live` verdicts, keyboard shortcuts
- [ ] Verify the Access gate end-to-end on phone + laptop (One-time
      PIN login, PWA install through it, offline boot after login)
- [ ] Backup/restore: scheduled `wrangler d1 export --remote --output
      backups/<date>.sql` (laptop cron or CI) + documented restore
      procedure (`d1 execute --file` / `d1 time-travel restore`)
- [ ] README for humans (install, run, back up, plan-tier notes)

**Acceptance:** daily use on phone + laptop for two weeks with zero
manual interventions.

## Later (V2, non-blocking)

- [ ] OpenRouter `LLMClient` implementation +
      `user_config.llm_provider` switch (choose provider on demand;
      V1 ships Workers AI only)
- [ ] Evaluate Workers Paid only when a measured limit bites
      (CPU/request on Free, D1 queries per invocation, 30-day Time
      Travel)
- [ ] Optional Anki export (D2's never-blocking nice-to-have)

---

## Ordering rationale

Phase 1 before everything: the loop's existence is the product's
existence — content can be thin at first (seed vocab covers months of
new items). Phase 2 before reading/writing because offline tolerance is
a stated requirement and retrofitting it later is the expensive path.
Reading before writing because capture-into-queue compounds the
vocabulary loop. Phase 5.5 after 5 because it reuses the LLM seam and
the validation tooling that Phases 3/5 establish — the story pool is
content machinery plus a queue, nothing new in the session path.

## Out of scope (do not add during these phases)

Listening, grammar-drill banks, mock exams, deck/config UI, multi-user,
native app, handwriting. See OVERVIEW.md non-goals and
LEARNING-DESIGN §8 anti-requirements.