# API Contract

JSON over HTTPS in every environment (plain HTTP on the local dev
server). All times UTC ISO-8601.
Version prefix: `/api`. Errors: `{"error": {"code": "...", "message": "..."}}`
with appropriate HTTP status.

## Idempotency rules (offline sync)

- The client generates UUIDs: one for the session (`session_uuid`), one
  per response (`response_uuid`).
- Server enforces `UNIQUE` on both; replaying the same UUID returns
  `200` with the original result (no double-count).
- Batch response upload is **partially successful**: per-item results
  are returned; already-known UUIDs are reported as `duplicate: true`
  and the client drops them from its queue.

## Endpoints

### `GET /api/status`

Home screen data.

```json
{
  "streak_days": 4,
  "last_session": "2026-02-10T19:22:00Z",
  "due_count": 12,
  "totals": {"vocabulary": 8334, "kanji": 2091, "passages": 120},
  "weakest_bucket": "kanji"
}
```

Notes:
- On a first run `last_session` and `weakest_bucket` are `null`,
  `streak_days`/`due_count` are `0`.
- `totals.passages` stays `0` until Phase 3 ships content — v1 serves
  no passages (D-2).

### `POST /api/session/start`

Composes and returns the **entire session snapshot** (see LEARNING-DESIGN
→ Session builder for composition rules).

Request — `session_uuid` is the client-generated idempotency key and
is **required**; `max_minutes` is an optional composition hint the
server may ignore:

```json
{ "session_uuid": "…", "max_minutes": 12 }
```

Response:

```json
{
  "session_uuid": "…",
  "title": "Session 12 · 10–15 min",
  "prompts": [
    {
      "prompt_key": "r:jlpt:n5:毎朝:meaning",
      "kind": "recall",
      "bucket": "vocab_recog",
      "is_new": false,
      "instruction": "Type the meaning",
      "stimulus": "毎朝",
      "input": "text",                    // text | text+selfgrade | choice
      "grading": {"rule": "keyword", "alternatives": ["every morning"]}
    },
    {
      "prompt_key": "w:jlpt:n3:合図:produce",
      "kind": "production",
      "bucket": "writing",
      "is_new": true,
      "instruction": "Write a sentence using 合図",
      "stimulus": "合図 (sign)",
      "input": "text+selfgrade",
      "grading": {"rule": "production", "must_contain": ["合図"]}
    },
    {
      "prompt_key": "p:n4:park-quiet:q1",
      "kind": "passage_question",
      "bucket": "reading",
      "passage_ref": "n4:park-quiet",     // resolved into snapshot below
      "instruction": "公園について、正しいものは？",
      "choices": ["…", "…", "…"],
      "input": "choice"
    }
  ],
  "passages": [
    {"key": "n4:park-quiet", "level": "n4", "title": "…", "body": "…"}
  ],
  "adaptation_note": "New items focus: kanji readings (weakest 7d: 60%)",
  "fast_skip_available": false
}
```

Notes:
- `passages` carries full bodies so the session is self-contained offline.
- `adaptation_note` is user-visible text — this is how "the system
  adjusted" becomes legible without a dashboard.
- `fast_skip_available` is `true` only until the first session row
  exists; it gates the first-run "I know this" action
  (LEARNING-DESIGN §1 fast-skip).
- A prompt always carries `is_new`, `stimulus` and `grading`; the
  `passage_question` example above omits them because passage prompts
  are graded by `answer_index` (Phase 3).

### `POST /api/responses` (batch)

Flushed online or from the offline queue. May be called mid-session.

```json
{
  "session_uuid": "…",
  "responses": [
    {
      "response_uuid": "…",
      "prompt_key": "r:jlpt:n5:毎朝:meaning",
      "item_key": "vocab:jlpt:n5:毎朝:meaning",
      "bucket": "vocab_recog",
      "answer": "every morning",
      "self_grade": null,
      "latency_ms": 4200
    }
  ]
}
```

Response (per item):

```json
{ "results": [
  {"response_uuid": "…", "duplicate": false, "grade": "correct",
   "srs": {"due_at": "2026-02-13T00:00:00Z", "interval_days": 3}},
  {"response_uuid": "…", "duplicate": false, "grade": "shaky",
   "correct_answer": "合図",
   "checks": [{"value": "合図", "passed": true}],
   "srs": {"due_at": "2026-02-13T00:00:00Z", "interval_days": 3.6}}
]}
```

Notes:
- `correct_answer` powers the inline learning moment (`✗ — correct
  was …`) and `checks` the production ✓/✗ line; both appear when the
  item was graded. `grade` is omitted for capture and fast-skip
  entries — there was nothing to grade.
- Replaying a known `response_uuid` returns `duplicate: true` with the
  original result: no re-grade, no double-count (idempotency rules).
- `interval_days` is fractional when the grade was `shaky`
  (LEARNING-DESIGN §1).

The client may show the grade inline (immediate feedback) — grading is
server-side even when online, so a response round-trip is expected; if
the round-trip fails, the response is queued (offline path) and grading
display is deferred to the summary.

### `POST /api/session/complete`

```json
{ "session_uuid": "…", "duration_sec": 640 }
```

Response — Done screen content:

```json
{
  "summary": {
    "reviews": {"done": 8, "correct": 7},
    "new": {"done": 3, "correct": 2},
    "reading": {"passage": "n4:park-quiet", "questions": 3, "correct": 3,
                 "unknown_words_captured": 2},
    "writing": {"graded": "solid"},
    "streak_days": 5
  },
  "next_session": {
    "preview": "8 reviews · 3 new (kanji readings) · 1 passage",
    "note": "Kanji readings are your weakest area right now."
  }
}
```

Notes:
- `summary.reading` and `summary.writing` appear only once those
  prompt kinds exist (Phases 3–4); v1 sends `reviews`, `new` and
  `streak_days`.
- `next_session.preview` is a real projection of what the next
  `session/start` will serve — it must match, not approximate.

### `POST /api/responses` with reading capture

Unknown-word capture during a reading prompt:

```json
{"session_uuid": "…", "responses": [
  {"response_uuid": "…", "prompt_key": "capture:n4:park-quiet",
   "bucket": "reading", "answer": "アスファルト",
   "kind_hint": "unknown_word"}
]}
```

Server resolves against `vocabulary` (fills reading/meaning/item_id when
the word is in the seed) and inserts into `unknown_words`.

### `POST /api/responses` with first-run fast-skip

"I know this" on a recall prompt while `fast_skip_available`:

```json
{"session_uuid": "…", "responses": [
  {"response_uuid": "…", "prompt_key": "r:kanji:一:onkun",
   "item_key": "kanji:一:onkun", "bucket": "kanji",
   "kind_hint": "fast_skip"}
]}
```

No `answer` and no `self_grade` — nothing was typed or graded; the
result carries `duplicate` and the `srs` block only. The server
suspends the item for 30 days (LEARNING-DESIGN §1 fast-skip).

A `kind_hint` is exclusive: a graded response must not carry one, and
`fast_skip`/`unknown_word` entries must.

### `GET /api/status` — offline behavior

If the device is offline when the user taps Start:

- Client requests `POST /api/session/start`; on network failure it shows
  "Connect once to fetch your next session" **only if no snapshot is
  cached**. Queued answers from prior sessions are always safe to hold.
- Practical rule: prefetch one session snapshot whenever connectivity
  exists (e.g. app open / background sync), so an offline tap almost
  always has a session ready.

## Client-side persistence (not API)

IndexedDB stores:
1. `pending_session` — the current snapshot (deleted on completion),
2. `pending_responses` — answer queue with UUIDs (deleted on ack).

Service worker precaches the app shell. The client is disposable; the
server is the source of truth.

## Non-goals for v1 API

- No auth endpoints (deployment-level access control only).
- No websocket/push — polling is unnecessary; sessions are pull-based.
- No LLM endpoints — evaluation, if enabled, is async server-side after
  session completion (Phase 5) and never part of this contract.