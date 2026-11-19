<script lang="ts">
  // P1.12 — Home screen (UX.md §1): streak + "Last: …" + ONE primary CTA.
  //
  // Data rules:
  //   • GET /api/status loads in the background — the CTA never waits on
  //     it (tap-to-first-prompt ≤ 5 s); a failed status load degrades
  //     silently: no streak/Last lines, CTA fully usable.
  //   • While session/start is in flight the CTA LABEL becomes
  //     "Preparing…" (UX.md: never a spinner-only screen); a failure shows
  //     one muted line under the CTA (aria-live for screen readers).
  //   • "Last:" shows the relative day only, on D-3's UTC calendar-day
  //     basis — status carries no duration, so UX.md's "· 12 min" clause
  //     has no contract data (P1.12 Notes decision 1).
  //   • Offline CTA states are Phase 2 — out of scope here.
  import { onMount } from "svelte";
  import { fetchStatus } from "./api";

  let { onstart }: { onstart: () => Promise<void> } = $props();

  let streakDays = $state(0);
  let lastSession = $state<string | null>(null);
  let preparing = $state(false);
  let startError = $state<string | null>(null);

  onMount(() => {
    void fetchStatus()
      .then((status) => {
        streakDays = status.streak_days;
        lastSession = status.last_session;
      })
      .catch(() => {
        // Silent degradation — Home renders without streak/Last (Notes).
      });
  });

  /** Relative day label on D-3's UTC calendar-day basis. */
  function lastLabel(iso: string): string {
    const utcDay = (ms: number): number => Math.floor(ms / 86_400_000);
    const days = utcDay(Date.now()) - utcDay(Date.parse(iso));
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    return `${days} days ago`;
  }

  async function start(): Promise<void> {
    preparing = true;
    startError = null;
    try {
      await onstart();
    } catch {
      startError = "Couldn't prepare your session — try again.";
    } finally {
      preparing = false;
    }
  }
</script>

<main>
  <h1>learn-jp-web</h1>
  {#if streakDays > 0}
    <p class="streak">🔥 {streakDays}-day streak</p>
  {/if}

  <button type="button" onclick={start} disabled={preparing}>
    {preparing ? "Preparing…" : "Start session"}
  </button>
  {#if startError}
    <p class="error" role="status" aria-live="polite">{startError}</p>
  {/if}

  {#if lastSession}
    <p class="last">Last: {lastLabel(lastSession)}</p>
  {/if}
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

  .streak,
  .last,
  .error {
    margin: 0;
    color: color-mix(in srgb, CanvasText 60%, transparent);
    font-size: 0.95rem;
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

  button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  button:focus-visible {
    outline: 3px solid Highlight;
    outline-offset: 2px;
  }
</style>