# Data Model

Single SQLite database (WAL mode). Two families of tables:

- **Content tables** — populated once from seed JSON at setup,
  immutable at runtime.
- **Runtime tables** — accumulate user activity; the source of truth
  for SRS state, history, and adaptation.

## Seed data (files in `data/seed/`)

### `vocabulary.json` — 8,334 items

```json
[
  {
    "item_id": "jlpt:n5:毎朝",
    "content": "毎朝",
    "reading": "まいあさ",
    "meaning": "every morning",
    "level": "n5",
    "part_of_speech": "Noun",
    "source": "jlpt"
  }
]
```

- `item_id` is the stable global key (`jlpt:<level>:<surface>`).
- `reading` = kana reading; `meaning` = English gloss (may contain
  `;`/`,`-separated alternatives — grading treats these as keyword
  alternatives, see LEARNING-DESIGN.md).
- Coverage: n5 662 · n4 632 · n3 1,784 · n2 1,793 · n1 3,463.
- Readings and parts of speech are pre-enriched; ~100% complete.

### `kanji.json` — 2,091 items

```json
[
  {
    "item_id": "kanji:一",
    "character": "一",
    "on_reading": "イチ,イツ",
    "kun_reading": "ひと-,ひと.つ",
    "meanings": "one;one radical (no.1)",
    "level": "n5",
    "stroke_count": 1
  }
]
```

Readings comma-separated; `on` = On'yomi, `kun` = Kun'yomi.

### Provenance (not loaded at runtime)

- `data/source/jlpt/n{1..5}_vocab.json` — original level word lists.
- `data/source/kanjidic2.xml.gz` — KANJIDIC2 dump.
- `data/cache/jisho_cache.json` — dictionary lookups used during
  enrichment (raw API responses, reusable for later re-enrichment).

### Future seed files (content pipeline, Phases 3–4)

- `passages.json` — reading passages with embedded comprehension
  questions.
- `writing_prompts.json` — prompts with model answers and required
  patterns.

## Schema

DDL below is the design target; exact types may be adjusted during
implementation, semantics must not.

```sql
-- ─── content tables (seeded, immutable) ─────────────────────────

CREATE TABLE vocabulary (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id       TEXT UNIQUE NOT NULL,     -- 'jlpt:n5:毎朝'
    content       TEXT NOT NULL,
    reading       TEXT,                     -- kana
    meaning       TEXT NOT NULL,
    level         TEXT NOT NULL,            -- 'n5'..'n1'
    part_of_speech TEXT,
    source        TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_vocab_level ON vocabulary(level);

CREATE TABLE kanji (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     TEXT UNIQUE NOT NULL,       -- 'kanji:一'
    character   TEXT NOT NULL,
    on_reading  TEXT,                       -- comma-separated
    kun_reading TEXT,                       -- comma-separated
    meanings    TEXT,
    level       TEXT NOT NULL,
    stroke_count INTEGER,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE passages (                     -- reading bank (seed)
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT UNIQUE NOT NULL,
    level       TEXT NOT NULL,
    title       TEXT,
    body        TEXT NOT NULL,
    created_by  TEXT DEFAULT ('seed'),      -- 'seed' | 'llm:<model>'
    curated     INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE passage_questions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    passage_key TEXT NOT NULL REFERENCES passages(key),
    ordinal     INTEGER NOT NULL,
    prompt      TEXT NOT NULL,
    choices     TEXT NOT NULL,              -- JSON array of 3–4 strings
    answer_index INTEGER NOT NULL,
    explanation TEXT,
    vocab_focus TEXT                        -- JSON array of item_ids
);

CREATE TABLE writing_prompts (              -- writing bank (seed)
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    key             TEXT UNIQUE NOT NULL,
    level           TEXT NOT NULL,
    kind            TEXT NOT NULL,          -- 'sentence' | 'short_text'
    prompt          TEXT NOT NULL,          -- JP instructions/stimulus
    model_answer    TEXT NOT NULL,
    required_tokens TEXT,                   -- JSON array of required substrings
    vocab_focus     TEXT,                   -- JSON array of item_ids
    created_at      TEXT DEFAULT (datetime('now'))
);

-- ─── runtime tables ─────────────────────────────────────────────

CREATE TABLE srs_state (                    -- one row per item key
    item_key    TEXT PRIMARY KEY,           -- see keying rules below
    kind        TEXT NOT NULL,              -- prompt kind it belongs to
    ease        REAL NOT NULL DEFAULT 2.5,
    interval_days REAL NOT NULL DEFAULT 0,
    due_at      TEXT NOT NULL,              -- datetime, UTC
    reps        INTEGER NOT NULL DEFAULT 0,
    lapses      INTEGER NOT NULL DEFAULT 0,
    suspended   INTEGER NOT NULL DEFAULT 0, -- known-on-first-see fast-skip
    last_grade  TEXT,
    updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_srs_due ON srs_state(due_at, suspended);

CREATE TABLE sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_uuid   TEXT UNIQUE NOT NULL,     -- idempotency key from client
    started_at    TEXT NOT NULL,            -- UTC
    completed_at  TEXT,                     -- NULL if abandoned
    snapshot      TEXT NOT NULL,            -- JSON: prompts served
    stats         TEXT,                     -- JSON: counts, per-bucket accuracy
    duration_sec  INTEGER
);

CREATE TABLE responses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES sessions(id),
    client_uuid TEXT UNIQUE NOT NULL,       -- idempotent offline replay
    prompt_key  TEXT NOT NULL,              -- stable key of the prompt
    item_key    TEXT,                       -- SRS target (NULL for passage MC)
    answer      TEXT,                       -- user's raw input
    grade       TEXT NOT NULL,              -- 'correct'|'incorrect'|'shaky'
    self_grade  TEXT,                       -- 'solid'|'shaky'|'wrong' | NULL
    bucket      TEXT NOT NULL,              -- skill bucket (see below)
    latency_ms  INTEGER,
    created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_resp_session ON responses(session_id);
CREATE INDEX idx_resp_created ON responses(created_at);

CREATE TABLE unknown_words (                -- captured while reading
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id       TEXT,                     -- vocabulary.item_id if known
    surface       TEXT NOT NULL,            -- word as encountered
    reading       TEXT,
    meaning       TEXT,                     -- filled when resolved
    source_passage TEXT,                    -- passages.key
    status        TEXT DEFAULT 'queued',    -- 'queued'|'in_review'|'retired'
    created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE user_config (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);
```

## Item keying (SRS identity)

One SRS row per *practice target*, not per word — the same word is
practiced in multiple directions:

| Kind | item_key example | Direction |
|---|---|---|
| `meaning` | `vocab:jlpt:n5:毎朝:meaning` | see JP → type EN |
| `reading` | `vocab:jlpt:n5:毎朝:reading` | see meaning/JP → type kana |
| `kanji_reading` | `kanji:一:onkun` | see kanji → type reading |
| `production` | `vocab:jlpt:n5:毎朝:produce` | use word in a sentence |
| `passage_q` | `passage:n4:park:q2` | comprehension (usually not SRS-scheduled; see LEARNING-DESIGN) |
| `writing` | `writing:n3:school-day` | prompted short writing |

## Skill buckets

Every response is tagged with the bucket it exercised:

- `vocab_recog` — meaning/reading recall prompts
- `kanji` — kanji reading prompts
- `reading` — passage comprehension + unknown-word density
- `writing` — sentence/short-text production

Buckets drive (a) which skill gets new items next session and (b) the
weakness display. Rolling accuracy is computed from `responses` over a
7-day window on demand (no summary table needed at this scale; add a
materialized summary only if queries get slow).

## Session stats (JSON shape)

```json
{
  "counts": {"reviews": 8, "new": 3, "reading": 1, "writing": 1},
  "accuracy": {"vocab_recog": 0.87, "kanji": 0.60, "reading": 1.0, "writing": 1.0},
  "buckets_practiced": ["kanji", "vocab_recog", "reading"]
}
```

## Retention & integrity

- All datetimes stored UTC ISO-8601.
- `sessions.snapshot` keeps exactly what was served — replays and
  audits stay possible even if seed content changes later.
- No deletion of runtime rows; abandoned sessions keep
  `completed_at = NULL` and still count partial responses.
- Database backups = file copy (WAL checkpoint before copy, or
  `VACUUM INTO`).

## Import procedure (setup time)

1. Create schema (above).
2. Load `data/seed/vocabulary.json`, `kanji.json` (idempotent upsert on
   `item_id`).
3. When they exist: `passages.json`, `writing_prompts.json`.
4. Record `schema_version` and `seed_hash` in `user_config` so re-import
   after content updates is detectable.