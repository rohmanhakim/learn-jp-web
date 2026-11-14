# Learning Design

The rules that decide **what is prompted, how it is graded, and how the
next session changes**. Everything here runs server-side and is
deterministic unless explicitly marked otherwise.

## 1. Spaced repetition (SRS)

Algorithm: **SM-2** (owned in-house; no third-party scheduler).

Per `srs_state` row:

```
on graded response g ∈ {correct, shaky, incorrect}:

  incorrect  → lapses += 1
               interval_days = 0  (re-queued today's queue)
               ease = max(1.3, ease - 0.20)
  shaky      → interval_days = max(1, interval_days * 1.2)
               ease = max(1.3, ease - 0.05)      # counts as passing
  correct    → reps += 1
               interval = reps == 1 ? 1
                          : reps == 2 ? 3
                          : round(previous * ease)
               ease unchanged

  due_at = now + interval_days          # correct/shaky
  due_at = now                          # incorrect (due again same session queue next time)
```

- Grades come from the prompt's grading rule (§2); `shaky` arises from
  self-grade `~ shaky` on production prompts, and from keyword matches
  that only partially hit.
- New items start `interval_days = 0, due_at = now`.
- **Fast-skip (first-run onboarding):** every recall prompt in the very
  first session offers an "I know this" action → row created with
  `suspended = 1, due_at = now + 30d`. This replaces a placement test:
  the user blows through known material in one session and the queue
  settles at their real frontier.
- Passage comprehension questions are **not** SRS-scheduled items
  (they're contextual); only vocabulary/kanji/production kinds get
  `srs_state` rows.

## 2. Prompt kinds & grading rules

| Kind | Stimulus → Input | Grade rule |
|---|---|---|
| `recall/meaning` | JP word → type EN meaning | **keyword**: normalize (lowercase, strip punct/whitespace); split expected on `;` `,` `(`…`)`; correct if any expected keyword is contained in the answer or vice versa |
| `recall/reading` | EN meaning (or JP word+hint) → type kana | **normalized exact**: NFKC, strip whitespace, katakana→hiragana; correct if equals any reading alternative |
| `kanji_reading` | kanji (in word context) → type kana | same as `recall/reading`; accept either on or kun reading when the word permits both |
| `production` | word/pattern → write a sentence | **deterministic checks**: must contain the target; any `required_tokens` present; optional simple particle/pattern presence checks. Grade = checks verdict, then merged with self-grade: checks pass + `solid` → `correct`; checks pass + `shaky` → `shaky`; checks fail or `wrong` → `incorrect` |
| `passage_question` | passage + question → choice | `answer_index` equality |
| `writing` | prompt → free text | Phase 1–4: deterministic checks (length ≥ N chars, required tokens) + self-grade, same merge as production. Phase 5: optional async LLM evaluation updates a stored quality flag — **never** blocks or retroactively changes session records |

All normalization/grading happens server-side; the client sends raw
input. When a recall answer is wrong, the correct answer is shown inline
(a learning moment, not just a score).

## 3. Buckets

Four skill buckets, assigned per prompt:

`vocab_recog` · `kanji` · `reading` · `writing`

Each has a **rolling accuracy** = correct / total graded responses in
the last 7 days (computed on the fly from `responses`; a bucket with no
data counts as neutral, not weakest).

## 4. Session builder

Target duration 10–15 min. Composition, in order:

```
1. reviews      all due srs rows (suspended excluded)
                 cap 25 — oldest-due first; overflow rolls to next session
2. new items    3–5 items (default 3) drawn ONLY from the weakest bucket
                 by rolling accuracy; from that bucket: level = highest
                 level with <X% lifetime accuracy among learned items,
                 defaulting to the lowest level not yet exhausted
                 (simple heuristic: pick lowest level where new items
                 remain, but the *kind mix* — e.g. kanji readings vs
                 meanings — follows the weakest bucket)
3. content      exactly ONE of: a reading passage (+1–3 questions)
                 OR a writing prompt (or none, if neither bank exists yet)
                 reading: passage chosen from highest level whose
                 expected known-word ratio ≥ 85% (estimate from
                 vocabulary table against passage text)
                 writing: from the weakest *productive* bucket's level
4. adaptation_note  one human sentence stating what the system focused
                 on and why (shown on session open + Done)
```

- If there is nothing due and no new items possible (empty bank at
  level), the session still runs content prompts — never a dead end.
- Session is fixed at start (snapshot); adaptation therefore applies
  from the *next* start. This keeps offline sessions coherent.

### Reading coverage estimate

Known-word ratio = matched tokens (vocabulary table) / total content
tokens of the passage, using longest-match segmentation against known
entries plus a stopword/okurigana fallback. Rough is fine — it only
orders passage choice; 85% is the floor for comfort, not a guarantee.

## 5. Adaptation (what changes between sessions)

Inputs: per-bucket 7-day accuracy, per-item SRS state, unknown-word
queue size.

| Signal | Effect on next session |
|---|---|
| bucket weakest (7d) | new items drawn from that bucket's kind (e.g. weak kanji → more kanji-reading prompts) |
| bucket accuracy ≥ 90% over 2 weeks | that bucket's new-item share shrinks (floored at 1 per session so nothing rots) |
| unknown_words queue growing | reading content favored on alternating sessions; queued words surface as `recall/reading` prompts |
| many lapses on a level | new items stall at that level until review load clears |
| streak / recency | no effect on content — only displayed |

User never configures any of this. It is visible only through
`adaptation_note` (API.md).

## 6. Content pipeline (seed time, offline)

Purpose: grow the passage and writing banks. Runs as dev-time tooling,
**never during a session**.

1. **Generate** — batch LLM call producing N passages/prompts per level
   against a strict JSON schema (level, vocab constraint list drawn
   from `vocabulary.json`, question count, answer keys).
2. **Validate** — deterministic checks: parses, answer_index in range,
   vocab constraint respected, known-word ratio in band.
3. **Curate** — human review; reject/fix outliers. Only curated items
   get `curated = 1` and enter the seed.
4. **Export** — `data/seed/passages.json`, `writing_prompts.json`;
   imported via the DATA-MODEL import procedure.

Budget: LLM spend happens here (generation) and optionally at Phase 5
(async writing evaluation). Runtime cost of a session = zero tokens.

## 7. Onboarding (first run)

1. Import seed → empty SRS.
2. First session = fast-skip run: recall prompts with "I know this"
   available on every item; system records what's known vs not.
3. From session 2 onward, the normal builder runs; the queue is already
   sized to the user's frontier.

No placement test screen, no questionnaire.

## 8. Unknown-word capture

While reading, tapping a word → "Add to your queue?" → one tap.

- If the surface exists in `vocabulary`: auto-fill reading/meaning.
- Else: stored with surface only; meaning filled manually later (or
  looked up offline by a helper tool — never blocks the session).
- Queued words surface as `recall/reading` prompts (weakest-relevant),
  which converts reading encounters into retention.

This replaces "generated enrichment": words the user *actually met in
context*, chosen by the user.

## 9. Anti-requirements (regression guard)

These are part of the design; adding them back breaks the product:

- No start/end session ceremony — sessions start with one tap and end
  by completing or explicit exit.
- No deck/schedule/config UI in the study path.
- No network requirement to practice (once a snapshot exists).
- No LLM in the prompt-serving path.
- No multiple-choice for recall prompts (typing is the practice).
- No dashboard the user must read to decide anything.