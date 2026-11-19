<script lang="ts">
  // P1.12 — app shell (Phase-001.md Milestone D): view switching across
  // UX.md's exactly three screens with NO router library. App owns the
  // current view and the session snapshot returned by session/start.
  // Home → Session is wired here; the real Session screen (P1.13) and
  // the Done screen (P1.14) fill in next — Done is never routed through
  // Home after a session (UX.md hard rule).
  import Home from "./Home.svelte";
  import Session from "./Session.svelte";
  import { startSession } from "./api";

  type View = "home" | "session" | "done";

  let view = $state<View>("home");
  let session = $state<Awaited<ReturnType<typeof startSession>> | null>(null);

  /** CTA path: fresh idempotency key → snapshot → straight into the session. */
  async function beginSession(): Promise<void> {
    session = await startSession({ session_uuid: crypto.randomUUID() });
    view = "session";
  }
</script>

{#if view === "home"}
  <Home onstart={beginSession} />
{:else if view === "session" && session}
  <Session {session} />
{:else}
  <!-- P1.14 placeholder — the Done screen. -->
  <main><p>Done screen arrives with P1.14.</p></main>
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
    align-items: center;
    justify-content: center;
    padding: 2rem 1rem;
    text-align: center;
    color: color-mix(in srgb, CanvasText 60%, transparent);
  }
</style>
