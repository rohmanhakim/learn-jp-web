# Product Overview

## Problem

Studying Japanese fails not from lack of material but from friction:
every study session used to require a preparation ritual (starting
external tools, syncing, managing decks, deciding what to study) before
a single minute of actual practice. Rituals kill consistency, and
consistency is the only thing that builds a language.

Separately, most study tools optimize for vocabulary flashcards, while
the actual goal here is **reading and writing** — skills that flashcard
recall alone does not train.

## Vision

Open the app. Tap once. Do exactly what the screen prompts. Close it.
Everything else — scheduling, content selection, grading, performance
history, adaptation — is handled by the system, invisibly.

**Tap-to-first-prompt ≤ 5 seconds, zero manual setup, ever.**

## Target user

Single user (the project owner), self-studying Japanese, irregular
schedule, practices in short pockets of time on phone or laptop.

## Goals

1. **Reading practice**: read short Japanese passages; answer graded
   comprehension questions; capture unknown words met in context into
   the personal learning queue.
2. **Writing practice**: produce Japanese sentences/short texts from
   prompts; receive grading (deterministic checks + self-grade now,
   optional LLM evaluation later).
3. **Retention**: keep previously learned vocabulary and kanji alive
   via spaced repetition, with typed answers (no multiple-choice
   crutches for recall items).
4. **Zero-friction loop**: one entry point, one button, system-chosen
   session content, automatic progress recording, visible adaptation
   across sessions.
5. **Practice whenever**: works on phone and laptop; tolerates
   flaky/offline connectivity without losing progress.

## Non-goals

- **Not a general JLPT exam-prep suite.** Listening, grammar-pattern
  drills, and timed mock exams are out of scope; the user studies those
  with other resources. JLPT levels (N5–N1) are used **only as a
  difficulty ordering/tag** for content, not as exam targets.
- **No third-party flashcard app dependency.** The SRS is owned
  in-house. (Optional manual export could exist someday; it is never on
  the critical path.)
- **No study-ritual features**: no deck management, no scheduling
  configuration, no start/end session ceremony, no dashboards the user
  must interpret before practicing.
- **No handwriting capture** in v1 — production is typed (IME on any
  device). Handwriting is a possible later surface, not a v1 requirement.
- **Not multi-user, not public**: single account, private deployment.
  No accounts system beyond a simple deployment-level gate.
- **No native mobile app** in v1 — the PWA is installable and
  offline-capable; native wrappers are a possible later step.

## Success metrics

| Metric | Target |
|---|---|
| Tap-to-first-prompt | ≤ 5 seconds |
| Setup steps before a session | 0 (post-install) |
| Sessions that complete losing zero data | 100% (offline included) |
| Features requiring manual user decisions before practicing | 0 |
| Consistency signal | streak visible on home screen; sessions adapt to measured weakness |

## Scope summary

**In (v1):** guided sessions (recall prompts, reading passages with
comprehension questions, writing prompts), in-house SM-2 spaced
repetition, per-skill performance tracking, session adaptation, offline
practice with sync, seed content import, streak/summary.

**Later / conditional:** LLM grading of free-form writing (async,
on-blocking), personalized story generation (async, ahead-of-time
pool — DECISIONS D13), harvested real-world reading material,
handwriting surface, native wrapper, export to external flashcard
tools.

**Never:** deck/schedule configuration UI, listening exam drills,
multi-tenant accounts.

## Content levels

Seed content is tagged `n5 → n1` (loosely aligned with JLPT vocabulary
lists). The tags drive difficulty ordering for session building; nothing
in the product promises exam readiness.