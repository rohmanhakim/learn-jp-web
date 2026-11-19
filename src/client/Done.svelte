<script lang="ts">
  // P1.14 — the Done screen (UX.md §3): real summary counts, streak,
  // next_session.preview + adaptation note, ONE Done button back Home.
  // Replaces App.svelte's Done-lite placeholder wholesale.
  //
  // Decisions (Phase-001.md Notes):
  //   (a) data is EXACTLY the /session/complete payload handed over by
  //       Session — no client-side computation, no second fetch: counts
  //       come from the server's `responses` rows, so a mid-session exit
  //       counts too, and `next_session.preview` is P1.11's real
  //       projection of the next session/start.
  //   (b) `completed === null` (the complete call failed) renders no
  //       fabricated numbers: heading + one muted aria-live line + the
  //       Done button. Streak/Next are omitted because neither exists
  //       without the payload.
  //   (c) reading/writing rows render only when those optional summary
  //       fields arrive (Phase 3–4 prompt kinds) — the screen lights up
  //       with zero edits later. v1 shows reviews / new words / streak.
  //   (d) streak line shows only when > 0 (Home's rule — a brand-new
  //       user has nothing to celebrate); mockup's 🔥 5-day is the >0 case.
  // No charts, no scores, no ceremony (LEARNING-DESIGN §9) — the mockup's
  // counts + one adaptation sentence are the entire feedback loop.
  import type { SessionCompleteResponse } from "../worker/api-types";

  let {
    completed,
    ondone,
  }: {
    completed: SessionCompleteResponse | null;
    ondone: () => void;
  } = $props();

  /** Count rows per the UX.md mockup — `correct/done`, in display order. */
  const rows = $derived.by(() => {
    const summary = completed?.summary;
    if (!summary) return [];
    const list: { label: string; value: string }[] = [
      { label: "reviews", value: `${summary.reviews.correct}/${summary.reviews.done}` },
      { label: "new words", value: `${summary.new.correct}/${summary.new.done}` },
    ];
    if (summary.reading) {
      list.push({
        label: "reading",
        value: `${summary.reading.correct}/${summary.reading.questions} + ${summary.reading.unknown_words_captured} saved`,
      });
    }
    if (summary.writing) {
      list.push({ label: "writing", value: summary.writing.graded });
    }
    return list;
  });
</script>

<main>
  <h1>Session complete</h1>

  {#if completed}
    <dl class="counts">
      {#each rows as row (row.label)}
        <div class="row">
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      {/each}
    </dl>
    {#if completed.summary.streak_days > 0}
      <p class="streak">🔥 {completed.summary.streak_days}-day streak</p>
    {/if}

    <p class="next">Next: {completed.next_session.preview}</p>
    <p class="note">{completed.next_session.note}</p>
  {:else}
    <!-- Completion failed server-side of us — never invent numbers (b). -->
    <p class="note" role="status" aria-live="polite">Couldn't load your session summary.</p>
  {/if}

  <button type="button" onclick={ondone}>Done</button>
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

  h1 {
    font-size: 1.5rem;
    font-weight: 600;
    margin: 0;
  }

  .counts {
    margin: 0;
    display: grid;
    grid-template-columns: auto auto;
    gap: 0.4rem 1.5rem;
    text-align: left;
    font-size: 1.05rem;
  }

  .row {
    display: contents;
  }

  dt {
    color: color-mix(in srgb, CanvasText 60%, transparent);
  }

  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }

  .streak {
    margin: 0;
    font-size: 1.05rem;
  }

  .next {
    margin: 0;
    font-size: 1.05rem;
  }

  .note {
    margin: 0;
    max-width: 24rem;
    color: color-mix(in srgb, CanvasText 60%, transparent);
    font-size: 0.95rem;
    line-height: 1.6;
  }

  button {
    font: inherit;
    font-size: 1.2rem;
    min-height: 3.25rem;
    padding: 0.75rem 3rem;
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
