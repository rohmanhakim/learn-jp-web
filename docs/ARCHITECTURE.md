# Architecture

## Principles

1. **One brain, one dumb screen.** All intelligence — scheduling,
   session composition, grading, adaptation — lives server-side. The
   client renders prompts and posts answers. This is what makes "I only
   do what the system prompts" literally true.
2. **Deterministic-heavy, LLM-minimal.** ~90% of operations are
   deterministic code. LLMs are used only for (a) one-time seed-time
   content generation, (b) optional asynchronous evaluation of
   free-form writing, and (c) asynchronous, ahead-of-time generation of
   personalized stories into a validated pool (DECISIONS D13). All
   three run outside the request path: never at prompt-time; never
   blocking a session.
3. **Offline-first.** The app must work with no connectivity; sync
   happens opportunistically. A session started offline must complete
   offline.
4. **Single deployable.** One Cloudflare Worker serves the built
   frontend (static assets) and the API, backed by one D1 database.
   Access control (Cloudflare Access) sits in front of the Worker and
   is a deployment concern, not an application feature.

## System diagram

```
┌────────────────── PWA (Svelte + TypeScript) ──────────────────┐
│                                                               │
│  Home screen ──▶ Session screen ──▶ Done screen               │
│       │               │                                       │
│       │        IndexedDB cache                                │
│       │        (session snapshot + answer queue)              │
│       │               │                                       │
│  Service worker (app shell precache, offline boot)            │
└───────────────────────┬───────────────────────────────────────┘
                        │  HTTPS JSON  (see API.md)
                        │  · online: live requests
                        │  · offline: local queue, flushed on reconnect
┌───────────────────────▼────────────────────────────────────────┐
│      Cloudflare Access — One-time PIN (single user)            │
│      edge gate for every route; no in-app auth (D8)            │
└───────────────────────┬────────────────────────────────────────┘
┌───────────────────────▼────────────────────────────────────────┐
│           Worker — TypeScript + Hono (one deployable)          │
│                                                                │
│  /api/* routes            static assets (SPA shell → PWA)      │
│                                                                │
│  session_builder   grader          srs (SM-2)     adapter      │
│  (picks prompts)   (scores answers)(due tracking) (next mix)   │
│        │               │              │              │         │
│        └───────────────┴──────┬───────┴──────────────┘         │
│                               ▼                                │
│                     LLMClient seam (Zod-validated)             │
│              V1: Workers AI binding · V2: OpenRouter           │
│                               ▲                                │
│   Queues (producer after session/complete, scheduled top-up)   │
│   writing-eval · story-gen  →  consumer, retries + DLQ         │
└───────────────────────┬────────────────────────────────────────┘
                        ▼
                  Cloudflare D1 (SQLite)
   content tables (seed + validated generated) │ runtime tables
                        │ one-time import (generated SQL file)
                ┌───────▼──────────┐
                │ data/seed/*.json │  (+ future passage & prompt banks)
                └──────────────────┘
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
- Build/deploy: Vite with `@cloudflare/vite-plugin` builds both the
  client bundle and the Worker. The client is deployed as Workers
  Static Assets in SPA mode (`not_found_handling: "single-page-application"`);
  only `/api/*` routes invoke the Worker script.

### Backend — Worker (TypeScript + Hono)

Single Worker serving:

- **Routes** (`/api/*`): thin Hono handlers with Zod validation. Each
  route set is exported as a type (`AppType`) and consumed by the PWA
  through `hono/client` (`hc<AppType>`), so the API contract is
  compile-time checked on both ends.
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
- **scheduled() handler**: housekeeping and content-pool top-ups
  (cron triggers); never on the session path.
- **queue() handlers**: consumers for the async LLM work below.

### AI inference (provider-neutral seam)

All LLM calls go through one interface:

```
LLMClient.complete(schema, prompt) → Zod-validated result
  V1: Workers AI implementation  (env.AI binding, free tier, no keys)
  V2: OpenRouter implementation  (secret + user_config.llm_provider)
```

- Two call sites, both asynchronous and outside the request path:
  1. **writing-eval queue** — Phase 5 evaluation of free-form writing.
  2. **story-gen queue** — Phase 5.5 personalized story pool (D13).
- The seed-time content pipeline (dev-time script) uses the same seam
  against the provider's REST API.
- Model IDs live in config (`user_config`), never in call sites.
- Queue delivery is at-least-once; consumers are idempotent
  (`response_uuid` / `profile_hash` UNIQUE) with retries and a
  dead-letter queue. A dead provider degrades to "self-grade stands,
  stories fall back to seed" — never to a blocked session.
- Tests mock the interface; no test needs a live provider.

### Storage — Cloudflare D1 (SQLite)

- One D1 database. Content tables are immutable after seed import;
  runtime tables accumulate sessions/responses. Schema in
  [DATA-MODEL.md](DATA-MODEL.md).
- Managed storage: no WAL pragmas, no file to copy. Migrations are
  versioned SQL applied with `wrangler d1 migrations apply` (a backup
  is captured before each apply); schema is defined with Drizzle ORM
  and generated to SQL.
- Single primary region (no read replication needed for one user);
  writes and reads in one request are trivially consistent at this
  scale. D1's Sessions API remains available if replication is ever
  enabled — not part of v1.
- Backup story: scheduled `wrangler d1 export` (SQL dump) + D1 Time
  Travel point-in-time restore. See Deployment.

### Content pipeline (offline, at seed time)

A dev-time workflow (not part of runtime) that generates and curates:

- reading passages + comprehension questions per level,
- writing prompts + model answers per level,

using batch LLM generation, human curation, then export to JSON seed
files. Runtime never calls an LLM to build a session from scratch —
the Phase 5.5 personalization pool (D13) generates *ahead of time* and
feeds stories through this same deterministic validator before they
become servable. See LEARNING-DESIGN.md → Content pipeline.

### Access control (deployment concern)

- Cloudflare Access (Zero Trust) protects the Worker hostname:
  **One-time PIN** login to a single approved email. No accounts, no
  login UI, no session logic in the app (API.md: no auth endpoints).
- Optional service tokens (`CF-Access-Client-Id/Secret` headers) for
  scripts hitting the API from a terminal.
- Local development is unaffected: `vite dev` runs without Access.

## Data flow — one session

```
1. POST /api/session/start           (or: read queued snapshot)
2. Server: srs.due() → session_builder.compose() → snapshot returned
3. Client: render prompt → user answers → client posts response
   (batched if offline) → server grades, updates srs + session
4. Repeat until last prompt → POST /api/session/complete
5. Server: finalize session row, compute summary + next-session
   projection → Done screen
   └─ async (after response): queue producers fire — writing eval for
      production answers, story-gen if the pool lacks a story for the
      new profile. Results land in D1 before the *next* session start.
```

Adaptation happens at step 5 (and step 1): performance from completed
sessions changes what step 2 composes next time.

## Tech stack & environment

| Layer | Choice | Notes |
|---|---|---|
| Runtime (backend) | Cloudflare Workers, TypeScript | `wrangler types` generates `Env` from config |
| HTTP framework | Hono + Zod (`@hono/zod-validator`) | exported `AppType` → `hono/client` on the PWA |
| Storage | Cloudflare D1 (SQLite) via Drizzle ORM | migrations via `wrangler d1 migrations` |
| Async | Cloudflare Queues | writing-eval, story-gen; retries + DLQ |
| AI | Workers AI (V1) → OpenRouter option (V2) | behind the `LLMClient` seam, Zod-validated |
| Frontend | Svelte + TypeScript + Vite | `@cloudflare/vite-plugin`, SPA assets mode |
| Access | Cloudflare Access (One-time PIN) | edge gate; no in-app auth |
| Dev tooling | Node 24, Wrangler, Vitest (`@cloudflare/vitest-plugin`) | tests run inside workerd with real bindings |
| CI | lint + `wrangler types --check` + `vitest` + `vite build` | keep minimal |

## Deployment

- **Local development:** `npm run dev` starts the Vite dev server with
  the Cloudflare plugin — Worker code runs in a local `workerd`
  process with a local D1 database (same engine as production). Local
  Explorer (`/cdn-cgi/local/explorer`) browses/edits local D1 data and
  fires `scheduled()` handlers.
- **Production:** `npm run build && npx wrangler deploy`. One Worker,
  static assets + `/api/*`, one D1 database. First deploy requires a
  one-time Cloudflare account/zone and an Access application on the
  hostname (One-time PIN, single email) — see Phase 0 / Phase 6 in
  TASKS.md.
- **Plan tier:** Workers **Free covers single-user daily load** by a
  wide margin (requests, rows, storage, queues, 10k AI neurons/day).
  The one limit to measure in Phase 1 is **CPU per request (10 ms on
  Free)** — SM-2 + grading should sit around 1–5 ms. Workers Paid
  ($5/mo) is an optional headroom upgrade (higher CPU/D1-query limits,
  30-day Time Travel, longer log retention), taken only if a measured
  constraint appears.
- **Backup & restore** (replaces "file copy"):
  - Scheduled `wrangler d1 export --remote --output backups/<date>.sql`
    (laptop cron or CI) — durable, portable SQL dump.
  - D1 **Time Travel**: always-on point-in-time restore, 7 days on
    Free / 30 days on Paid, free of charge; `wrangler d1 migrations
    apply` also captures a backup before each migration.
  - Restore = `wrangler d1 execute <db> --file backups/<date>.sql`, or
    `wrangler d1 time-travel restore --timestamp=…`.
- **Privacy note:** app bundle and database live on Cloudflare's edge.
  Acceptable under D9 (private repository, private use, seed content
  license-friendly). Access gating keeps it single-user.

## Cross-cutting rules

- All timestamps UTC in storage; display local.
- Idempotency: every client-originated write carries a client-generated
  UUID so replays after offline sync never double-count (see API.md).
- The database is the single source of truth; the client cache is
  disposable.
- All LLM calls go through the `LLMClient` seam with Zod-validated
  outputs; no call site speaks to a provider directly.
- No feature may add a step between "open app" and "first prompt".