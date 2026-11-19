<script lang="ts">
  // P1.12/P1.13/P1.14 — app shell (Phase-001.md Milestone D): view
  // switching across UX.md's exactly three screens with NO router library.
  // App owns the current view, the session snapshot from session/start, and
  // the completion payload the Session screen hands over on last prompt or
  // confirmed exit; Done.svelte (P1.14) renders it. Done is never routed
  // through Home after a session (UX.md hard rule).
  import Done from "./Done.svelte";
  import Home from "./Home.svelte";
  import Session from "./Session.svelte";
  import { startSession } from "./api";
  import type { SessionCompleteResponse } from "../worker/api-types";

  type View = "home" | "session" | "done";

  let view = $state<View>("home");
  let session = $state<Awaited<ReturnType<typeof startSession>> | null>(null);
  /** Handed over by Session (P1.13); Done.svelte (P1.14) renders it. */
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
  <!-- Real Done screen (P1.14) — `completed` is null when the complete
       call failed; Done renders that degraded case without numbers. -->
  <Done {completed} ondone={() => (view = "home")} />
{/if}

<style>
  :global(body) {
    margin: 0;
    background: Canvas;
    color: CanvasText;
    font-family: "Hiragino Sans", "Noto Sans JP", "Yu Gothic", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
</style>
