# Phase 2 — Offline-first (PWA)

Expanded breakdown of the "Phase 2 — Offline-first (PWA)" section of
[TASKS.md](TASKS.md). TASKS.md stays the source of truth for phase
order and phase-level acceptance; this file is the working plan for
Phase 2 only: sub-tasks (P2.1 … P2.8), per-sub-task acceptance
criteria, dependencies, and decisions. Mapping to TASKS.md's six
bullets: P2.1 → 1 (service worker), P2.2 → 2 (IndexedDB), P2.3–P2.5 →
3 (offline paths), P2.6 → 4 (sync flush), P2.7 → 5 (Access
coexistence), P2.8 → 6 (Lighthouse).

**Scope:** everything that makes a session survivable without
connectivity — service worker + app shell precache, the IndexedDB
snapshot/answer queue, offline UI paths, and reconnect sync. No
server/API/schema change (the Phase 1 contract already carries the
idempotency rules — API.md §Idempotency), no content work (Phases
3–4), no LLM (Phase 5), no new prompt kinds.

**Why this phase exists:** "practice whenever" includes no-signal
situations, and losing progress would break trust (DECISIONS D6); it
is a stated success metric ("Sessions that complete losing zero data
— 100%, offline included", OVERVIEW.md). It comes before reading and
writing because those add content pieces that must *also* ship inside
the offline snapshot (API.md: passages carry full bodies precisely so
the session is self-contained) — retrofitting the queue afterwards
would mean building the offline path twice (TASKS.md ordering
rationale).

**Sub-task numbering:** `P2.n` (Phase-001.md uses `P1.n`,
Phase-001.5.md uses `P1.5.n`; Phase-001.md's prompt factory is
`P1.5`). No ambiguity with this file's `P2.n`.

**Phase-level acceptance (from TASKS.md):** airplane-mode session on
a phone completes end-to-end and its data appears in the DB after
reconnect; replaying the queue double-counts nothing. Plus Lighthouse
PWA checks: installable, offline-capable, score ≥ 90.

**Notes fields:** every sub-task has a *Notes* block, left empty
until implementation starts. Fill it during/after the session that
implements the sub-task: decisions actually taken, deviations from
this plan, links to commits, and anything a later session needs to
know. Do not tick a sub-task's checkbox without its Notes being
filled.

**Status legend:** `[ ]` not started · `[~]` in progress · `[x]`
done (Notes filled, tests green).

---

## Dependency order

```
P2.1 (SW + manifest) ─→ P2.2 (IDB layer) ─→ P2.3 (queue-first submit)
                  │                            ├─→ P2.5 (resume/partial save)
                  │                            └─→ P2.6 (flush + replay)
                  └───────────────────────────→ P2.4 (Home offline states)
P2.1 ─→ P2.7 (Access ↔ SW coexistence)
everything ─→ P2.8 (Lighthouse + airplane-mode acceptance)
```

Milestones: **A** offline shell (P2.1–P2.2) · **B** offline session
path (P2.3–P2.5) · **C** sync & acceptance (P2.6–P2.8). P2.4 can be
built as soon as P2.2 exists (it only reads the snapshot slot).

---

## Milestone A — Offline shell

### P2.1 Service worker + web app manifest — `vite.config.ts`, `public/`

- [ ] Dependency: `vite-plugin-pwa` **pinned to an exact version** in
      `devDependencies` (D-1; same pinning logic as `wanakana` in
      P1.5.1 — see Appendix for the survey and the upstream-churn
      flag), config added to `vite.config.ts` **after** verifying
      interplay with `@cloudflare/vite-plugin`: the client builds into
      `dist/client`, so the precache glob directory must point at the
      built client — verify `sw.js` and `manifest.webmanifest` land at
      URLs Workers Static Assets actually serve, at root scope
- [ ] `generateSW` strategy: precache the app shell (HTML + JS/CSS
      chunks — including the `wanakana` chunk from Phase 1.5),
      `navigateFallback` → precached `index.html`,
      `cleanupOutdatedCaches: true`; registration via
      `virtual:pwa-register` from `src/client/main.ts` with
      `registerType: "autoUpdate"` (D-1) — no update-prompt UI (UX.md:
      no chrome the user must interpret)
- [ ] Web app manifest (Lighthouse "installable"): `name` /
      `short_name`, `display: standalone`, `start_url: "/"`, theme +
      color-scheme matching `index.html`'s `light dark`. The repo has
      **no icon and no `public/` today** — commit a minimal source
      icon and derive the 192/512 (+maskable) manifest icons from it
- [ ] Offline boot proof: after one online load, a hard reload with
      the network disabled renders the Home screen (data states are
      P2.4's job — an empty/last-known Home is acceptable here)
- [ ] Guard test in the spirit of D11's parity table / P1.5.1's pin:
      assert the precache manifest covers every client file `vite
      build` emits; if asserting build output inside workerd tests is
      impractical, document the manual check in Notes and fold it into
      P2.8's walkthrough

**Notes:**

### P2.2 IndexedDB layer — `src/client/storage.ts`

- [ ] Typed module over **native** IndexedDB (D-2) exposing exactly
      API.md's two stores: `pending_session` (one row: the session
      snapshot + in-progress cursor) and `pending_responses` (answer
      queue entries carrying `response_uuid`, insertion order
      preserved)
- [ ] Operations: `loadSession` / `saveSession` / `clearSession` and
      `enqueue` / `listQueue` / `remove` / `clearQueue` — promises
      only, typed errors, **no `fetch` and no UI knowledge inside**
      (pure persistence; the flush engine is P2.6)
- [ ] One schema: `indexedDB.open(…, 1)` with a single upgrade path;
      DB name `learn-jp-web`; every stored value is
      JSON-serializable contract data (a real snapshot fixture
      round-trips byte-identical)
- [ ] Tests target an **in-memory implementation of the same
      interface** (workerd has no IndexedDB — the same environment
      caveat P1.5.3 recorded): enqueue→list→remove ordering, dedup on
      re-enqueue of a known `response_uuid`, snapshot round-trip with
      a real `SessionStartResponse` fixture, queue survives a
      simulated "kill" (interface torn down and rebuilt over the same
      store)
- [ ] No new runtime dependency (D-2); `npm run check` green

**Notes:**

## Milestone B — Offline session path

### P2.3 Queue-first submit path — `src/client/Session.svelte`

Anchors in the current code: `gradeAndAdvance()` (line ~284 — its
`catch` at ~300 logs and *drops* the answer today) and `fastSkip()`
(line ~254, same pattern).

- [ ] Write-through: every response (graded recall, production +
      self-grade, `fast_skip`) is appended to `pending_responses`
      **before** any network attempt. The network call becomes
      best-effort: success removes the entry and paints the verdict;
      failure leaves it queued
- [ ] Verdict window logic unchanged: the screen advances at
      `VERDICT_MS` regardless — the network can never block the next
      prompt (UX.md). Offline, the window shows the **queued** badge
      instead of a grade (UX.md interaction table; D-3 — no
      client-side grade guess)
- [ ] Online behavior stays exactly Phase 1: one-per-prompt send with
      an immediate inline verdict; the queue only carries what a send
      failed to deliver
- [ ] Phase-1.5 coupling (Phase-001.5.md's phase-level note): the
      queued `answer` must be the **post-conversion** field value —
      assert in a test that a `normalized_exact` prompt queues the
      kana the user actually saw; the `compositionstart/end` guard and
      `bind()`/`unbind()` are **not touched** by this task
- [ ] `inflight` / `finishing` semantics preserved: `finish()` still
      awaits in-flight work, but an offline complete no longer
      degrades to `null` — it queues delivery (P2.5) and the Done
      screen renders the queued state (D-3)

**Notes:**

### P2.4 Home offline states + snapshot slot — `src/client/Home.svelte`

- [ ] CTA states per UX.md: online → normal; offline **with** a
      cached snapshot → CTA stays live and starts from the cache
      (straight into prompt 1); offline **without** a snapshot → CTA
      reads "Connect once to prepare your session" (UX.md line 41,
      API.md line 229)
- [ ] Snapshot slot policy (D-6): on app open while online, if
      `pending_session` is empty, prefetch one session with a
      client-generated `session_uuid` and store the snapshot under
      that id; tapping Start online **uses the slot** (no second
      `session/start`), so a prefetched session is always the session
      the user actually runs — at most one pending row ever exists
- [ ] Prefetch never delays the protected metric: fire-and-forget;
      the CTA renders from cached `GET /api/status` data first
      (tap-to-first-prompt ≤ 5 s stands, with or without the prefetch)
- [ ] Offline Home renders last-cached status (streak, due count,
      last session) as the muted glanceable text it already is — no
      new UI, no charts

**Notes:**

### P2.5 Resume & partial save — session lifecycle in IndexedDB

- [ ] Progress cursor persisted with the snapshot (current prompt
      index, updated on each `advance()`): app killed mid-session →
      reopening resumes at the first unanswered prompt (UX.md
      interaction table)
- [ ] Exit mid-session: existing confirm → `finish()`; if the
      `session/complete` call fails offline, the completion is
      **queued** (ordering with the responses flush is P2.6/D-5) and
      Done renders the local Done-lite summary (D-3)
- [ ] `pending_session` lifecycle: written at Start/prefetch, updated
      per advance, cleared only when a completed session has been
      flushed; crash between last prompt and complete → next launch
      still holds the slot, resume lands on the last prompt, and the
      idempotent `session/complete` replay finalizes it
- [ ] First-run fast-skip works offline too: the cached snapshot's
      `fast_skip_available` gates the button exactly as online
      (LEARNING-DESIGN §7) — the skip just enters the queue

**Notes:**

## Milestone C — Sync & acceptance

### P2.6 Sync flush engine — `src/client/sync.ts`

- [ ] Flush triggers: `online` event, `visibilitychange` → visible,
      app open, and after a successful Start — opportunistic, per
      ARCHITECTURE principle 3 ("sync happens opportunistically").
      **No Background Sync API** (D-4)
- [ ] Ordering: drain `pending_responses` as one batch **before**
      firing a queued `session/complete` — the summary must count
      every response (the endpoint already accepts batches; API.md)
- [ ] Partial success per API.md idempotency rules: per-item results
      — entries reported `duplicate: true` are dropped from the
      queue; failed/unacknowledged entries stay, with a per-entry
      retry counter (bounded; on giving up, keep + `console.warn`,
      never silently drop)
- [ ] Replay guard tests over a fake transport: flush twice over a
      queue of N → each `response_uuid` reaches the transport exactly
      once or is reported `duplicate` (never re-counted); empty-queue
      flush is a no-op; a `complete` never fires before its
      responses drain
- [ ] Reconciliation: after a flush, refresh `GET /api/status`; if
      the Done screen is still open on the queued summary, replace it
      with the server's real summary (D-3)

**Notes:**

### P2.7 Cloudflare Access ↔ service worker coexistence — deployed build

- [ ] First visit: Access One-time PIN → app loads → SW registers →
      precache completes (all precache fetches are same-origin,
      authenticated requests)
- [ ] The SW must never cache an Access login/redirect response:
      precache is manifest-driven only (exact build URLs +
      `navigateFallback` served from precache), with **no runtime
      caching of navigations**. Verify explicitly: expire/clear the
      Access session cookie, reload online → the Access login page,
      not a stale shell
- [ ] Offline after login: with no network at all (Access unreachable)
      the app boots from precache — the acceptance-critical path
- [ ] Verified against the real hostname (`npm run deploy`, Phase 0's
      Access application), not just localhost: login once in the
      browser, then airplane-mode reload

**Notes:**

### P2.8 Acceptance — Lighthouse + airplane-mode walkthrough

- [ ] `npm run check` green; Phases 0/1/1.5 unregressed (seed counts
      8,334 / 2,091, existing 280 tests, build path intact)
- [ ] Lighthouse on the built/deployed app: installable (valid
      manifest + icons + SW), works offline, **PWA score ≥ 90** —
      record the scores in Notes
- [ ] Phone walkthrough: install (add to home screen) → airplane mode
      → open → complete a full session offline (queued badges, no
      blocked prompts) → kill the app mid-session once and prove the
      resume → reconnect → flush → verify in D1 that every
      `response_uuid` landed exactly once and the streak/session rows
      are correct
- [ ] Replay proof: force the flush to run a second time → nothing
      double-counts (`duplicate: true` path + server UNIQUE)
- [ ] Desktop online sanity: verdict windows and the whole flow
      indistinguishable from Phase 1
- [ ] Walkthrough + scores + commits recorded in Notes; TASKS.md's
      Phase 2 bullets ticked

**Notes:**

## Decisions

Settled while breaking down Phase 2 (changing any of these requires
updating this file together with the affected design docs, per
[AGENTS.md](../AGENTS.md)):

- **D-1 · Service worker stack = `vite-plugin-pwa`, pinned,
  `generateSW` + `autoUpdate`.** Context: Phase 2 needs a precache
  manifest built from the Vite output, a web app manifest (Lighthouse
  installable), `navigateFallback`, and an update flow — all commodity
  plumbing. Rejected: *hand-rolled SW* (we'd own manifest injection,
  revision hashing, navigation fallback and the update lifecycle
  ourselves — more first-party code than the plugin, with no
  learning-logic benefit; D2's "own it" principle is about SRS/grading,
  not SW plumbing); *Workbox standalone* (same machinery, no Vite
  integration); *Serwist/newer toolkits* (smaller ecosystem, not needed
  for our scope). Consequences: exact-version pin + a
  precache-coverage guard test (P2.1), because upstream has announced
  next-gen packages and a Workbox transition (Appendix) — upgrades
  must be deliberate, exactly like the `wanakana` pin (P1.5.1) and
  D11's parity fixtures. `autoUpdate` (no update-prompt UI) is safe
  because the session snapshot lives in IndexedDB, outside the
  precache swap.
- **D-2 · Storage = one hand-written typed module over native
  IndexedDB; no Dexie / `idb`.** Context: exactly two stores and four
  operations (put/get/delete over two key spaces); the client is
  disposable and the server is source of truth (API.md). Rejected:
  *Dexie* (schema/observable machinery we won't use), *`idb`* (a
  runtime dependency to wrap four calls). Consequences: tests run
  against an in-memory implementation of the same interface (workerd
  has no IndexedDB); real-IDB behavior is proven in the P2.8
  walkthrough. Revisit only if stores gain real schema versioning.
- **D-3 · Offline grades are deferred, never guessed.** Context: all
  grading is server-side and the client contains no learning logic
  (ARCHITECTURE); API.md already settles this ("if the round-trip
  fails, the response is queued and grading display is deferred to
  the summary"). Consequences: the offline verdict window shows the
  **queued** badge; an offline completion renders Done-lite from
  locally-known facts (prompts answered, last-cached streak) marked
  as awaiting sync, and P2.6's reconciliation replaces it with the
  server summary after the flush. *Rejected:* client-side grade
  preview (would put grading logic in the client and could show a
  verdict the server disagrees with).

- **D-4 · Flush = opportunistic event triggers, no Background Sync
  API.** Context: Background Sync is unavailable in Safari/iOS — the
  primary device class under D1 — so it cannot be the mechanism;
  ARCHITECTURE principle 3 already defines sync as opportunistic.
  Consequences: `online` / visibility / app-open / post-Start
  triggers (P2.6); worst case a queue sits until the app is next
  opened, which is acceptable — queued answers are durable and the
  user never blocks on them.
- **D-5 · Flush order = responses batch → complete; `duplicate: true`
  dropped, failures retained.** Context: API.md's partial-success
  idempotency and Phase 1's UNIQUE constraints already exist — Phase
  2 only has to honor them. Consequences: the Done summary is
  computed after its responses land; replay safety is a client-side
  invariant tested over a fake transport (P2.6) plus the existing
  server tests.
- **D-6 · One-slot snapshot prefetch, reuse over refetch.** Context:
  API.md's practical rule ("prefetch one session snapshot whenever
  connectivity exists") vs. Phase 1's abandoned-row problem (a
  `session/start` that is never used inflated the session ordinal —
  P1.16 Notes). Decision: exactly one pending snapshot exists; it is
  fetched only when the slot is empty, Start **reuses** it (same
  `session_uuid` — idempotent), and it clears on completion — so a
  prefetch always becomes the session the user actually runs and at
  most one pending row can ever exist. Consequences: composition may
  be stale if the user sits on a prefetched session for days —
  accepted for v1 (server-side grading is unaffected; the next
  session recomposes). *Rejected:* no prefetch (contradicts API.md's
  stated rule); background refresh cron (new server surface for a
  cosmetic gain).

## Notes (phase-level)

- **Phase 1 code anchors the queue work replaces:** the two `catch`
  blocks that log-and-drop today — `Session.svelte` ~line 300
  (`gradeAndAdvance`) and ~line 267 (`fastSkip`) — plus
  `Home.svelte` line 14 (offline CTA deferred) and `api.ts` line 72
  (batch endpoint built for this queue). `sendResponses` already
  accepts a batch; only the call sites change.
- **Phase 1.5 couplings (from Phase-001.5.md's phase-level note):**
  (1) the queue stores the converted `answer` — automatic via
  P1.5.2's state-parity invariant, but asserted in P2.3's tests;
  (2) P2.3 must not disturb the `compositionstart/end` guard or
  `bind()`/`unbind()`; (3) the precache must include the `wanakana`
  chunk (P2.1).
- **Anti-requirements audit (LEARNING-DESIGN §9):** no start/end
  ceremony (the flush is invisible), no config UI (offline state is
  a badge, not a setting), no LLM, no network requirement (this phase
  *is* the offline story), no dashboard — UX.md's vending-machine
  intent holds. ARCHITECTURE's "client contains no learning logic"
  holds (D-3).
- **Deferred from Phase 1 (P1.16 open follow-up):** production
  CPU/request measurement needs a deploy + Workers Observability —
  Phase 6 owns it with the deployment pass, not here.
- **Open question:** the app icon (P2.1) — no design exists; a
  minimal glyph-on-solid-background placeholder ships first, refine
  during Phase 6 polish if desired.
- Suggested first session: **P2.1 + P2.2** together (shell +
  persistence — both are leaf dependencies with tests), then P2.3.
- This file does not modify [TASKS.md](TASKS.md); when a sub-task
  lands, tick the corresponding Phase 2 bullet there too.

## Appendix — service worker library survey (researched 2026-11-20)

| Option | What it gives | Verdict for this phase |
|---|---|---|
| **`vite-plugin-pwa`** (vite-pwa) | de facto Vite PWA layer: builds the SW via Workbox `generateSW` or `injectManifest`, generates/injects the web app manifest + icons, precache manifest from the Vite output, `virtual:pwa-register` for vanilla JS/Svelte, `navigateFallback` + `cleanupOutdatedCaches` defaults; Vite 8 peer range added in **1.3.0** (May 2026); depends on `workbox-build`/`workbox-window` 7.4.1 | **chosen (D-1)** — covers every TASKS.md bullet (precache, offline boot, installable) with config, not code; exact-version pin + precache-coverage guard because upstream announces next-gen packages / a Workbox transition (below) |
| Hand-rolled SW (~60–100 lines) + custom build step | full control, zero dependencies | rejected — we'd own revision hashing, manifest injection, navigation fallback and update lifecycle ourselves; no build-time manifest tooling exists in this repo, and none of it is learning logic worth owning (D2 scope) |
| Workbox standalone (`workbox-build` / `workbox-cli`) | the same Workbox engine without the Vite plugin | rejected — same machinery plus our own Vite integration code; strictly more work than the plugin |
| Serwist (ex-`@serwist/vite`) | modern Vite SW toolkit, ESM SW support | rejected — smaller ecosystem, features (module SWs, code-split SWs) beyond this phase's needs; revisit only if `vite-plugin-pwa` becomes unusable |
| No SW at all (HTTP cache only) | nothing to build | rejected — HTTP cache is not a guarantee offline, the manifest/installable bullets still need a SW, and Lighthouse "works offline" would fail |

**Upstream-churn flag (why D-1 pins an exact version):** the project
has announced next-generation packages (new `buildSW` engine, ESM
service workers, a `@vite-pwa/workbox` split) with the legacy
`vite-plugin-pwa` / Workbox line eventually marked obsolete — status
to re-verify at install time; if the legacy line is already frozen,
that is fine for us (we need only precache + fallback), provided the
version is pinned and the guard test in P2.1 holds. Node engine is
satisfied (`engines.node >= 24`).

Sources: [github.com/vite-pwa/vite-plugin-pwa](https://github.com/vite-pwa/vite-plugin-pwa) ·
[github.com/vite-pwa/vite-plugin-pwa/issues/918 (Vite 8 support)](https://github.com/vite-pwa/vite-plugin-pwa/issues/918) ·
[releases](https://github.com/vite-pwa/vite-plugin-pwa/releases) ·
[npmjs.com/package/vite-plugin-pwa](https://www.npmjs.com/package/vite-plugin-pwa)
