# Architecture

## Principles

1. **One brain, one dumb screen.** All intelligence — scheduling,
   session composition, grading, adaptation — lives server-side. The
   client renders prompts and posts answers. This is what makes "I only
   do what the system prompts" literally true.
2. **Deterministic-heavy, LLM-minimal.** ~90% of operations are
   deterministic code. LLMs are used only for (a) one-time seed-time
   content generation and (b) optional asynchronous evaluation of
   free-form writing. Never at prompt-time; never blocking a session.
3. **Offline-first.** The app must work with no connectivity; sync
   happens opportunistically. A session started offline must complete
   offline.
4. **Single deployable.** One Docker container serves the built
   frontend and the API, backed by one SQLite file.

## System diagram

```
┌────────────────── PWA (Svelte + TypeScript) ──────────────────┐
│                                                                │
│  Home screen ──▶ Session screen ──▶ Done screen                │
│       │               │                                       │
│       │        IndexedDB cache                                 │
│       │        (session snapshot + answer queue)               │
│       │               │                                       │
│  Service worker (app shell precache, offline boot)             │
└───────────────────────┬────────────────────────────────────────┘
                        │  HTTPS JSON  (see API.md)
                        │  · online: live requests
                        │  · offline: local queue, flushed on reconnect
┌───────────────────────▼────────────────────────────────────────┐
│                  Backend (FastAPI + Python)                    │
│                                                                │
│  session_builder   grader          srs (SM-2)     adapter      │
│  (picks prompts)   (scores answers)(due tracking) (next mix)   │
│        │               │              │              │         │
│        └───────────────┴──────┬───────┴──────────────┘         │
│                               ▼                                │
│                     SQLite (WAL mode)                          │
│   content tables (seed)  │  runtime tables (sessions/responses)│
└───────────────────────────┬────────────────────────────────────┘
                            │ one-time import at setup
                ┌───────────▼────────────┐
                │  data/seed/*.json      │
                │  (+ future passage &   │
                │   prompt banks)        │
                └────────────────────────┘
```

## Components

### Frontend — PWA (Svelte + TypeScript, Vite)

- Three screens only: **Home** (one button + streak), **Session**
  (one prompt at a time), **Done** (summary + next-session note).
- The client contains **no learning logic**: no grading algorithms, no
  scheduling, no "what's next" heuristics. It posts answers and renders
  what the server says next.
- Offline: at session start the server returns the **entire session
  snapshot** (all prompts). The client stores it in IndexedDB, renders
  locally, queues answers, and flushes the queue on reconnect. If the
  device is offline at start, the client requests a snapshot at next
  connect — the first session after install (or after a long offline
  stretch) requires one connection; everything else works offline.
- Service worker precaches the app shell so the app boots offline.

### Backend — FastAPI (Python)

Single process serving:

- **session_builder**: composes a session from due items, new items,
  and one content piece (passage or writing prompt) according to the
  mix rules in LEARNING-DESIGN.md.
- **grader**: applies the prompt's grading rule (exact / normalized /
  keyword match, multiple-choice index, deterministic production
  checks) and merges the user's self-grade where the prompt requires it.
- **srs**: SM-2 state machine per item key; computes next interval on
  each graded response.
- **adapter**: computes per-skill rolling accuracy and derives the next
  session's composition (which buckets get new items, difficulty mix).

### Storage — SQLite (WAL)

One database file. Content tables are immutable after seed import;
runtime tables accumulate sessions/responses. Schema in
[DATA-MODEL.md](DATA-MODEL.md).

### Content pipeline (offline, at seed time)

A dev-time workflow (not part of runtime) that generates and curates:

- reading passages + comprehension questions per level,
- writing prompts + model answers per level,

using batch LLM generation, human curation, then export to JSON seed
files. Runtime never calls an LLM to build a session. See
LEARNING-DESIGN.md → Content pipeline.

## Data flow — one session

```
1. POST /api/session/start           (or: read queued snapshot)
2. Server: srs.due() → session_builder.compose() → snapshot returned
3. Client: render prompt → user answers → client posts response
   (batched if offline) → server grades, updates srs + session
4. Repeat until last prompt → POST /api/session/complete
5. Server: finalize session row, compute summary + next-session
   projection → Done screen
```

Adaptation happens at step 5 (and step 1): performance from completed
sessions changes what step 2 composes next time.

## Tech stack & environment

| Layer | Choice | Notes |
|---|---|---|
| Runtime (backend) | Python ≥ 3.12 (dev env: 3.14) | FastAPI, uvicorn, Pydantic |
| Storage | SQLite, WAL mode | one file, zero ops |
| Frontend | Svelte + TypeScript + Vite | vite-plugin-pwa or hand-rolled SW |
| Dev tooling | Node 24, Docker 29 | confirmed available in dev env |
| Packaging | multi-stage Docker image: build frontend → serve static + API | one container |

## Deployment

- **v1 target: laptop-only** (`localhost`) — no public exposure.
- Design is deployment-neutral: the same container runs on a home
  server/NAS or a small VPS later without code changes (only
  deployment scripts differ; consider Tailscale if exposing).
- The app is private/single-user; no in-app account system. Access
  control, if ever exposed, is a reverse-proxy concern.

## Cross-cutting rules

- All timestamps UTC in storage; display local.
- Idempotency: every client-originated write carries a client-generated
  UUID so replays after offline sync never double-count (see API.md).
- The database is the single source of truth; the client cache is
  disposable.
- No feature may add a step between "open app" and "first prompt".