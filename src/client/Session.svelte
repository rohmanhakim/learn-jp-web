<script lang="ts">
  // P1.12 placeholder — the real Session screen (one prompt at a time,
  // header with progress + exit, typed answers, inline verdicts,
  // production self-grade) is P1.13. This stub exists ONLY so the app
  // shell can switch views and P1.12's ≤5 s tap-to-first-prompt
  // acceptance can land on a first prompt; it is fully replaced by
  // P1.13. The muted reload hint is the temporary way back home.
  import type { SessionStartResponse } from "../worker/api-types";

  let { session }: { session: SessionStartResponse } = $props();

  const first = $derived(session.prompts[0]);
</script>

<main>
  <p class="title">{session.title}</p>
  {#if first}
    <p class="count">1/{session.prompts.length}</p>
    <p class="instruction">{first.instruction}</p>
    {#if first.stimulus}
      <p class="stimulus">{first.stimulus}</p>
    {/if}
  {/if}
  <p class="stub">Prompt flow arrives with P1.13 — reload the page to return home.</p>
</main>

<style>
  main {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 2rem 1rem;
    text-align: center;
  }

  .title,
  .count {
    margin: 0;
    color: color-mix(in srgb, CanvasText 60%, transparent);
    font-size: 0.95rem;
  }

  .instruction {
    margin: 0;
    font-size: 1.05rem;
  }

  .stimulus {
    margin: 0;
    font-size: 2.5rem;
    line-height: 1.8;
  }

  .stub {
    margin: 2rem 0 0;
    color: color-mix(in srgb, CanvasText 45%, transparent);
    font-size: 0.9rem;
  }
</style>