<script lang="ts">
  // P1.12/P1.13 — app shell (Phase-001.md Milestone D): view switching
  // across UX.md's exactly three screens with NO router library. App owns
  // the current view, the session snapshot from session/start, and the
  // completion payload the Session screen hands over on last prompt or
  // confirmed exit (P1.14 renders it fully). Done is never routed through
  // Home after a session (UX.md hard rule).
  import Home from "./Home.svelte";
  import Session from "./Session.svelte";
  import { startSession } from "./api";
  import type { SessionCompleteResponse } from "./worker/api-types";

  type View = "home" | "session" | "done";

  let view = $state<View>("home");
  let session = $state<Awaited<ReturnType<typeof startSession>> | null>(null);
  /** Handed over by Session (P1.13); P1.14 replaces the lite line below. */
  let completed = $state<SessionCompleteResponse | null>(null);

  /** CTA path: fresh idempotency key → snapshot → straight into the session. */
  async function beginSession(): Promise<void> {
    completed = null;
    session = await startSession({ session_uuid: crypto.randomUUID() });
    view = "session";
  }

  /** Session hands off here — never routed through Home (UX.md hard rule). */
  function finish(result: SessionCompleteResponse | null): void {
    completed = result;
    view = "done";
  }
</script>

{#if view === "home"}
  <Home onstart={beginSession} />
{:else if view === "session" && session}
  <Session {session} oncomplete={finish} />
{:else}
  <!-- Done-lite placeholder — P1.14 replaces this whole branch with the
       real Done screen; meanwhile it shows what actually happened (UX.md
       exit → Done-lite summary) and a working way back home. -->
  <main>
    <p>Done screen arrives with P1.14.</p>
    {#if completed}
      <p class="lite">
        {completed.summary.reviews.done + completed.summary.new.done} answered · 🔥
        {completed.summary.streak_days}-day streak<br />
        next: {completed.next_session.preview}
      </p>
    {/if}
    <button type="button" onclick={() => (view = "home")}>Done</button>
  </main>
{/if}

<style>
  :global(body) {
    margin: 0;
    background: Canvas;
    color: CanvasText;
    font-family: "Hiragino Sans", "Noto Sans JP", "Yu Gothic", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  main {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 2rem 1rem;
    text-align: center;
    color: color-mix(in srgb, CanvasText 60%, transparent);
  }

  .lite {
    margin: 0;
    font-size: 1rem;
    line-height: 1.8;
    color: color-mix(in srgb, CanvasText 75%, transparent);
  }

  button {
    font: inherit;
    font-size: 1.05rem;
    min-height: 2.75rem;
    padding: 0.5rem 2rem;
    border: none;
    border-radius: 0.75rem;
    background: LinkText;
    color: Canvas;
    cursor: pointer;
  }

  button:focus-visible {
    outline: 3px solid Highlight;
    outline-offset: 2px;
  }
</style>
