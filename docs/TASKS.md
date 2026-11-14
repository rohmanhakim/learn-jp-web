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

- [ ] Project scaffold: FastAPI app skeleton, Svelte+Vite app, shared
      `Makefile`/scripts (`dev`, `test`, `seed`, `build`, `docker`)
- [ ] SQLite schema per DATA-MODEL.md + `schema_version`/`seed_hash` in
      `user_config`
- [ ] Seed importer: `data/seed/vocabulary.json` + `kanji.json`
      (idempotent upsert, verify counts 8,334 / 2,091)
- [ ] Import unit tests (counts, uniqueness of item_id, level tags valid)
- [ ] `docker build` produces an image serving API + static frontend
- [ ] CI or pre-commit: lint + tests (pick one, keep minimal)

**Acceptance:** `make seed && make dev` yields a running server with
seeded DB; `docker run` serves an (empty) page.

## Phase 1 — The core loop (MVP)

Recall prompts only — the loop itself must exist before content depth.

- [ ] SM-2 kernel (`srs` module) with unit tests for every grade path
      (first rep, second rep, mature, lapse, ease floor)
- [ ] Grading rules: `keyword`, `normalized exact` (+ NFKC, kana
      normalization) with normalization unit tests
- [ ] Session builder v1: due reviews + 3 new items (no content piece
      yet) + `adaptation_note`
- [ ] Endpoints: `POST /api/session/start`, `POST /api/responses`
      (batch, UUID-idempotent), `POST /api/session/complete`,
      `GET /api/status`
- [ ] Frontend: Home / Session / Done per UX.md (recall + production
      with self-grade)
- [ ] First-run fast-skip ("I know this") flow
- [ ] Sessions + responses persisted; streak computed from `sessions`
- [ ] Done screen shows `next_session.preview` derived from real data

**Acceptance:** complete the product-level definition of done on
localhost, desktop browser. No external services, no third-party
      integrations, no LLM.

## Phase 2 — Offline-first (PWA)

- [ ] Service worker: precache app shell; app boots offline
- [ ] IndexedDB: snapshot + answer queue (client_uuid per response)
- [ ] Offline paths per UX.md interaction-state table (queued badges,
      resume after kill, exit-mid-session partial save)
- [ ] Sync flush on reconnect with partial-success handling
      (`duplicate: true`), server UNIQUE constraints tested
- [ ] Lighthouse PWA checks: installable, offline-capable, score ≥ 90

**Acceptance:** airplane-mode session on a phone completes end-to-end
and its data appears in the DB after reconnect; replaying the queue
double-counts nothing.

## Phase 3 — Reading

- [ ] Content pipeline tooling (dev-time): batch generate → validate →
      human-curate → export `data/seed/passages.json`
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
- [ ] Async LLM evaluator for free-form writing: queued after
      `session/complete`, stores quality flag; **never** blocks or
      mutates session records; fully optional (feature-flagged, works
      when disabled)
- [ ] `adaptation_note` text derived from real signals

**Acceptance:** two consecutive weeks of sessions show composition
shifting toward measured weaknesses; app remains fully functional with
the LLM feature off.

## Phase 6 — Polish & deployment

- [ ] Mobile pass: typography, tap targets, IME quirks (composition
      events must not submit mid-IME)
- [ ] Light/dark, `aria-live` verdicts, keyboard shortcuts
- [ ] Docker deployment scripts for laptop (default) + optional
      server/VPS instructions (reverse-proxy notes, backup =
      `VACUUM INTO`)
- [ ] Backup/restore command for the SQLite file
- [ ] README for humans (install, run, back up)

**Acceptance:** daily use on phone + laptop for two weeks with zero
manual interventions.

---

## Ordering rationale

Phase 1 before everything: the loop's existence is the product's
existence — content can be thin at first (seed vocab covers months of
new items). Phase 2 before reading/writing because offline tolerance is
a stated requirement and retrofitting it later is the expensive path.
Reading before writing because capture-into-queue compounds the
vocabulary loop.

## Out of scope (do not add during these phases)

Listening, grammar-drill banks, mock exams, deck/config UI, multi-user,
native app, handwriting. See OVERVIEW.md non-goals and
LEARNING-DESIGN §8 anti-requirements.