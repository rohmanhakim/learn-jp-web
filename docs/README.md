# learn-jp-web — Documentation

Self-contained product documentation for **learn-jp-web**, a single-user
Japanese reading & writing practice app. This directory is the complete
context needed to continue development: read it as if the project starts
fresh here.

## Product in one paragraph

A self-hosted web app (installable PWA) that runs guided 10-minute
Japanese practice sessions. The user opens the app, taps one button, and
the system prompts a sequence of graded exercises (recall, reading,
writing). The system grades each response, stores performance, adapts the
next session, and repeats. The user never plans, schedules, manages
decks, or configures anything — every decision about *what to practice*
belongs to the system.

## Document index

| Doc | Purpose | Read when |
|---|---|---|
| [OVERVIEW.md](OVERVIEW.md) | Vision, goals, non-goals, success metrics, scope | First — establishes what the product is and is not |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, tech stack, offline strategy, deployment | Before designing or touching any system code |
| [DATA-MODEL.md](DATA-MODEL.md) | SQLite schema, seed-data format, content tables | Before writing backend persistence code |
| [API.md](API.md) | REST contract between PWA and backend, sync/idempotency rules | Before implementing client–server communication |
| [UX.md](UX.md) | Screens, session flow, interaction states, grading UX | Before building frontend components |
| [LEARNING-DESIGN.md](LEARNING-DESIGN.md) | Spaced repetition spec, session builder, grading rules, content pipeline | Before implementing any learning logic |
| [TASKS.md](TASKS.md) | Phased task list with acceptance criteria | When planning work; defines what "done" means per phase |
| [DECISIONS.md](DECISIONS.md) | Key design decisions and rejected alternatives | Before proposing changes to settled direction |

Root-level [AGENTS.md](../AGENTS.md) defines the working agreement for
AI-assisted sessions on this repository.

## Recommended reading order for a new session

1. `AGENTS.md` (working rules — usually loaded automatically)
2. `docs/OVERVIEW.md` — is this the product we are building?
3. `docs/TASKS.md` — where in the phase plan are we?
4. Relevant design doc for the task at hand (ARCHITECTURE / DATA-MODEL /
   API / UX / LEARNING-DESIGN)
5. `docs/DECISIONS.md` — before questioning any settled choice

## Repository layout

```
learn-jp-web/
├── AGENTS.md                 # working agreement for agent sessions
├── docs/                     # this documentation (product spec)
└── data/
    ├── seed/                 # canonical seed content (JSON, imported at setup)
    │   ├── vocabulary.json   # 8,334 JLPT-leveled words, readings + meanings + POS
    │   └── kanji.json        # 2,091 kanji, on/kun readings + meanings + level
    ├── source/               # raw provenance sources (not loaded at runtime)
    │   ├── jlpt/             # original per-level word lists (n1–n5)
    │   └── kanjidic2.xml.gz  # KANJIDIC2 dump
    └── cache/
        └── jisho_cache.json  # dictionary lookup cache used during enrichment
```

No application code exists yet. Implementation begins at Phase 0 of
[TASKS.md](TASKS.md).

## Glossary

- **Session** — one guided practice run of ~10–15 minutes, started by a
  single tap; the unit of user activity.
- **Prompt** — one exercise shown during a session (a question plus
  expected answer and grading rule).
- **Item / item key** — the durable identity of a practice target
  (e.g. a vocabulary word's meaning at a given level); keys SRS state.
- **SRS** — spaced repetition system; per-item scheduling of when an
  item is due again.
- **Bucket** — a skill category used for balancing session composition
  and tracking weakness (see LEARNING-DESIGN.md).
- **Self-grade** — user's quick quality verdict (solid / shaky / wrong)
  on their own production answer.
- **Seed content** — JSON files in `data/seed/` imported into SQLite at
  setup time.