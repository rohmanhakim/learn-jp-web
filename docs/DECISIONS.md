# Key Decisions

Settled direction for the product. Changing any of these requires
updating this file *and* the affected design docs in the same change.
Format: decision → context → alternatives rejected → consequences.

**Lineage:** this product revises the predecessor CLI project
`~/Projects/learn-jp` (Python + Anki + OpenRouter, now unmaintained).
Its lessons are the direct context behind D2 (Anki dropped), D3
(start/end ceremony dropped), D5 (deterministic-heavy, LLM-minimal —
its old "90/10" rule) and D9 (curated seed content); its
`WORKFLOW-FINDINGS.md` and `VIOLATION_BASED_LEARNING.md` are the
ancestors of LEARNING-DESIGN §8 (capture replaces auto-enrichment) and
D13 (story generation, minus the deck-bloat flaw).

## D1. Installable web app (PWA), not console/desktop/native

**Context:** practice must happen "whenever there is time" — phone and
laptop, anywhere — and all learning logic must live in one place.
**Rejected:** console app (desk-only, no offline story, no touch);
desktop app (same mobility problem); native mobile (2× build cost for a
single user; app-store friction).
**Consequences:** one codebase covers both device classes; offline
requires an explicit sync design (D6); native wrapper remains a cheap
future option if handwriting/push ever matter.

## D2. Own the SRS; no third-party flashcard dependency

**Context:** external flashcard tools forced a preparation ritual
before every session, were ungradeable for writing, and could not adapt
session composition.
**Rejected:** syncing with a flashcard app on the critical path.
**Consequences:** ~SM-2 is ~150 lines to implement and test (Phase 1);
we own all scheduling edge cases; optional export tools are
never-blocking nice-to-haves.

## D3. One-tap sessions; no start/end ceremony; system chooses content

**Context:** the original failure mode of studying was friction —
rituals before practice. The user wants to do *only what is prompted*.
**Rejected:** `start`/`end` command pairs; pre-flight checks that can
abort a session; dashboards to interpret before choosing what to study.
**Consequences:** sessions are self-contained snapshots; adaptation
applies from the next session; a "dead end" session (nothing due) must
still render prompts — the builder is responsible for never returning
an empty session.

## D4. Scope = reading + writing (+ retention); JLPT levels are only
difficulty tags

**Context:** the user studies other language skills with other
resources; the product should be deep, not broad.
**Rejected:** becoming a general exam-prep suite (listening, grammar
banks, timed mocks).
**Consequences:** four skill buckets (vocab_recog, kanji, reading,
writing); `n5..n1` tags order content difficulty only; no exam-score
projection features.

## D5. Deterministic-heavy, LLM-minimal

**Context:** LLM cost/latency/reliability in the session path would
recreate fragility; sessions must work offline.
**Rejected:** runtime question generation; LLM grading in the request
path.
**Consequences:** ~90% of operations are deterministic code; LLM usage
is confined to (a) seed-time content generation, (b) optional async
writing evaluation behind a feature flag, and (c) async, ahead-of-time
personalized story generation into a validated pool (D13); grading of
recall is normalization + keyword matching; production grading =
deterministic checks + user self-grade until Phase 5.

**Amendment (LLM providers):** every call goes through one
provider-neutral seam (`LLMClient`, Zod-validated outputs, model id
from config). V1 ships **Workers AI only** — free tier, no keys, no
billing. V2 adds an OpenRouter-compatible external provider,
switchable via `user_config.llm_provider`, so free/cheap external
models can be used on demand. Provider choice never affects the
determinism or async-only guarantees above.

## D6. Offline-first with snapshot + queue sync

**Context:** "practice whenever" includes no-signal situations; losing
progress would break trust.
**Rejected:** online-only sessions; conflict resolution complexity
(CRDTs, last-write-wins).
**Consequences:** the full session is fetched at start; answers queue
client-side with UUIDs; server is authoritative and idempotent
(replayed UUIDs are no-ops); first-ever session (or a stale cache)
needs one connection — an accepted, documented edge.

## D7. Typed production only (IME), no handwriting in v1

**Context:** grading handwriting needs canvas capture and a different
evaluation story; typing works identically on phone and laptop and
matches how the user reads/writes daily.
**Rejected:** handwriting capture at launch.
**Consequences:** all grading is server-side text processing;
handwriting is a possible later surface without changing the data
model (a new prompt kind).

## D8. Single-user, hosted on Cloudflare: one Worker, one D1 database

**Context:** no team, no scale ambitions, privacy preferred. Originally
specified as a localhost-only container; revised with the platform
move to Cloudflare (D12) while preserving the single-user, no-account
design.
**Rejected:** hosted multi-user service; Postgres; in-app accounts; a
public URL without a gate (access stays a deployment concern, not app
code).
**Consequences:** storage = one D1 database (SQLite-compatible,
managed, no WAL file); access control = Cloudflare Access in front of
the Worker (One-time PIN to a single email; optional service tokens
for scripts) — in-app auth remains a documented API non-goal; backup =
scheduled `wrangler d1 export` plus always-on D1 Time Travel (7-day
PITR on Free, 30-day on Paid), restore = `d1 execute --file` or
`d1 time-travel restore`; local dev unchanged (`vite dev` + local D1);
app bundle and data live on Cloudflare's edge — acceptable under D9
(private repository, private use).

## D9. Seed content ships in the repository

**Context:** sessions must never depend on external APIs; the content
(vocabulary, kanji, passages, prompts) is the product's core asset.
**Rejected:** fetching content at runtime; depending on live dictionary
APIs.
**Consequences:** repo carries ~5 MB of seed JSON (already curated and
enriched — readings/POS included); content updates are explicit imports
with `seed_hash` tracking; licensing must stay private-use-friendly
(hence: keep the repository private).

## D10. Content banks are generated once, curated by a human, then frozen

**Context:** reading passages and writing prompts must be level-accurate
and trustworthy; runtime generation contradicts D5/D6.
**Rejected:** generating passages/questions per session.
**Consequences:** a dev-time pipeline (generate → validate → curate →
export) exists in Phase 3/4; bank growth is a batch activity between
development sessions, not a runtime feature. (Applies to the seed
banks; the runtime story *pool* of D13 is governed separately — it
pre-generates between sessions and never at serve time.)

## D11. TypeScript end-to-end (backend included)

**Context:** the client is already TypeScript; one language means
shared API types (Hono `AppType` → `hono/client` compile-time-checked
on both ends) and one toolchain (Vitest, `wrangler types`);
Cloudflare Workers is a native TypeScript runtime.
**Rejected:** Python/FastAPI — even on Python Workers (GA) it runs as
CPython-via-Pyodide/WASM with package and cold-start constraints, and
would split the codebase into two languages for no benefit.
**Consequences:** backend logic (SM-2, grader, builder, adapter) is
small deterministic TS; the one real risk is Japanese text
normalization parity (JS `String.normalize('NFKC')` vs Python
semantics) — guarded by a parity fixture table in Phase 1; the old
Python tooling in the predecessor repo stays as provenance, only
future pipeline scripts are written in TS.

## D12. Full Cloudflare platform: one Worker (Hono) + D1 + Queues

**Context:** one deployable, zero ops; edge latency helps the protected
≤5 s tap-to-first-prompt metric; frontend and API ship together with
`vite build` + `wrangler deploy`.
**Rejected:** Docker container on laptop/VPS (the deployment target
moved; remains a documented fallback only); Cloudflare Containers (no
persistent disk — a SQLite file would not survive); Durable Object
SQLite as the primary store in v1 (strong consistency is attractive,
but there is no export-to-file API and no CLI migration story — kept
as an escape hatch); D1 read replication (a single primary is ample
for one user).
**Consequences:** the Worker serves static assets (SPA mode) plus
`/api/*`; Drizzle-generated SQL migrations via `wrangler d1
migrations`; Queues isolate all async LLM work (retries + DLQ);
Workers AI is the V1 provider (D5 amendment); **Workers Free covers
single-user load** — the one limit to measure is CPU/request (10 ms on
Free) in Phase 1, and Workers Paid ($5/mo) is an optional headroom
upgrade rather than a requirement; content is deployed to
Cloudflare's edge — fine under D9 (private repository, private use).

## D13. Personalized stories are generated ahead of time into a validated pool

**Context:** stories adapted to current mastery improve reading
practice; the predecessor project already prototyped violation-based
story generation and recorded its failure mode (deck bloat — its
WORKFLOW-FINDINGS).
**Rejected:** generating at session start (puts an LLM in the
prompt-serving path — LEARNING-DESIGN §9 — and breaks offline D6);
auto-adding story "violations" to the review queue (deck bloat; this
is exactly what §8 unknown-word capture replaced).
**Consequences:** generation runs on a queue after
`session/complete` (plus a `scheduled()` top-up) from a mastery profile
(known set + frontier targets + ≥85% level gate + genre rotation →
`profile_hash`); every story passes the same deterministic validator
as the seed pipeline before becoming `selectable`, with dedup on
`profile_hash` and quarantine on repeated bad comprehension outcomes;
the builder prefers a matching pool story and falls back to curated
seed passages (D10 / D3); queue or provider failure leaves behavior
byte-identical to Phase 3; words encountered in stories enter the SRS
only through §8 capture.

## D14. Kana input aid = client-side transliteration (WanaKana), never a candidate IME

**Context:** reading prompts demand a kana answer; on a device without
a Japanese IME the user can only type romaji, which `normalizeExact`
never converts — a correct reading grades incorrect. The reference UX
(Google Translate's romaji→kanji box) is not embeddable: the
Transliterate API was deprecated in 2011 and `google/google-input-tools`
is archived.
**Rejected:** (a) an in-app candidate widget / real IME engine
(hechima's Mozc-WASM, inputx-nihongo) — 1.5–17 MiB dictionaries,
experimental APIs, and above all a suggestion list that turns a
free-response recall prompt into a browsing exercise (the spoiler);
kanji commits also cannot grade under `normalized_exact`; (b)
dictionary converters (Kuroshiro, nyaitter-ime) — text→text,
unmaintained/too new, no field integration; (c) server-side romaji→kana
acceptance in `normalizeExact` — amends LEARNING-DESIGN §2 and the
Phase-1 parity fixtures, and lets a romaji string stand as a typed
reading; (d) binding conversion on every text field — mangles English
meaning answers; (e) status quo — kana prompts unanswerable without an
IME.
**Consequences:** `wanakana` (MIT, ~6.6 kB min+gz, bundled, no
network, zero advisories; low-churn upstream — behavior pinned by a
fixture table) is bound only to fields whose `grading.rule ===
"normalized_exact"`, with our own composition guard; grading, API, and
data model are untouched; no UI, toggle, or config is added
(LEARNING-DESIGN §9). Production answer entry stays platform-IME
(D7 unchanged). UX.md's input considerations amended in the same
change; working plan: Phase-001.5.md.