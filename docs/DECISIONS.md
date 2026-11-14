# Key Decisions

Settled direction for the product. Changing any of these requires
updating this file *and* the affected design docs in the same change.
Format: decision → context → alternatives rejected → consequences.

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
is confined to (a) seed-time content generation and (b) optional async
writing evaluation behind a feature flag; grading of recall is
normalization + keyword matching; production grading = deterministic
checks + user self-grade until Phase 5.

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

## D8. Single-user, self-hosted, one container, one SQLite file

**Context:** no team, no scale ambitions, privacy preferred.
**Rejected:** hosted multi-user service; Postgres; accounts system.
**Consequences:** zero-ops storage (WAL SQLite); access control is a
deployment concern (localhost by default; reverse proxy/Tailscale if
ever exposed); backup = file copy command.

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
development sessions, not a runtime feature.