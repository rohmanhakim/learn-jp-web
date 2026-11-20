<script lang="ts">
  // P1.13 — the Session screen (UX.md §2): one prompt at a time, slim
  // fixed header (n/total · progress · ✕), typed answers, inline
  // verdicts, production self-grade. Replaces P1.12's stub.
  //
  // Decisions (Phase-001.md Notes):
  //   (a) production's ✓/✗ contains line is a LOCAL preview — grading
  //       needs the self-grade, which doesn't exist yet, so no server
  //       round-trip is possible at that point. It mirrors grader.ts's
  //       check formula via normalizeExact (pure module → parity by
  //       construction). The response is sent ONCE after the self-grade
  //       tap; the server's checks/grade render the final verdict.
  //   (b) exit = confirm() → await in-flight /api/responses →
  //       /session/complete (duration_sec from screen entry) →
  //       oncomplete(result); counts derive from `responses` rows. An
  //       answer still awaiting self-grade was never sent (contract
  //       needs self_grade) and is not counted.
  //   (c) advancing NEVER fetches — the snapshot is in memory; the
  //       verdict races the single /api/responses call against the
  //       ~1.2 s window (timer starts at submit), so slow/failed calls
  //       cannot block the next prompt; failures are logged, Phase 2's
  //       queue owns retry/offline (UX.md "no network block…").
  //   (d) P1.15 fast-skip — when the snapshot carries
  //       `fast_skip_available`, every recall prompt offers "I know
  //       this": one tap sends a kind_hint=fast_skip response (no
  //       answer, no self_grade, NO verdict window — advance is
  //       synchronous) behind a 300 ms double-tap guard, because
  //       advance() swaps in the next prompt's enabled button within
  //       the same tick. The send joins `inflight` so finish() still
  //       awaits the row before /session/complete.
  // passage/choice prompts are Phase 3 — v1 serves
  // `text` and `text+selfgrade` only.
  import { onDestroy } from "svelte";
  import type {
    ResponseResult,
    ResponsesRequest,
    SessionCompleteResponse,
    SessionStartResponse,
  } from "../worker/api-types";
  import { itemKeyFromPromptKey, type SelfGrade } from "../worker/keys";
  import { normalizeExact } from "../worker/normalize";
  import { completeSession, sendResponses } from "./api";
  import { bindKanaInput, isKanaAnswerPrompt, unbindKanaInput } from "./kana-input";

  let {
    session,
    oncomplete,
  }: {
    session: SessionStartResponse;
    oncomplete: (result: SessionCompleteResponse | null) => void;
  } = $props();

  /** UX.md: inline verdict for ~1.2 s, then next. */
  const VERDICT_MS = 1200;

  /** UX.md chip copy — short nouns (session-builder's labels are long). */
  const BUCKET_SHORT: Record<string, string> = {
    vocab_recog: "vocab",
    kanji: "kanji",
    reading: "reading",
    writing: "writing",
  };

  const total = $derived(session.prompts.length);
  const enteredAt = Date.now();

  let index = $state(0);
  let phase = $state<"answering" | "checks" | "verdict">("answering");
  let answer = $state("");
  let verdict = $state<ResponseResult | null>(null);
  let finishing = $state(false);
  let fieldEl: HTMLInputElement | HTMLTextAreaElement | null = $state(null);

  let shownAt = Date.now();
  let answerLatencyMs = 0;
  let advanceTimer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<unknown> | null = null;

  let lastSkipAt = 0;

  const prompt = $derived(session.prompts[index]);
  const isProduction = $derived(prompt?.input === "text+selfgrade");
  const blank = $derived(answer.trim() === "");
  /** P1.15 — "I know this": first run only, recall prompts only, answering phase. */
  const canSkip = $derived(
    session.fast_skip_available && !isProduction && prompt !== undefined && phase === "answering",
  );
  const progress = $derived(total === 0 ? 0 : (index / total) * 100);
  const chip = $derived(
    prompt
      ? `${prompt.is_new ? "new" : "review"} · ${BUCKET_SHORT[prompt.bucket] ?? prompt.bucket}`
      : "",
  );

  /** Instruction + stimulus gloss: "Write a sentence using 合図 (signal)". */
  const productionHint = $derived.by(() => {
    if (!prompt || prompt.grading?.rule !== "production") return "";
    const surface = prompt.grading.must_contain[0] ?? "";
    const rest = prompt.stimulus?.startsWith(surface) ? prompt.stimulus.slice(surface.length) : "";
    return rest.trim();
  });

  /** Display-only mirror of grader.ts's production check (decision a). */
  const previewChecks = $derived.by(() => {
    if (!prompt || prompt.grading?.rule !== "production") return [];
    return prompt.grading.must_contain.map((value) => ({
      value,
      passed:
        normalizeExact(value) !== "" && normalizeExact(answer).includes(normalizeExact(value)),
    }));
  });

  /** Verdict copy (UX.md grading display conventions). */
  const verdictText = $derived.by(() => {
    if (phase !== "verdict") return "";
    if (verdict === null) return "…"; // grade round-trip still open
    if (verdict.grade === "correct") return "✓ correct";
    if (verdict.grade === "shaky") return "~ shaky";
    // Production failures read via the checks line; recall shows the
    // answer — the learning moment (§2 / UX.md).
    if (verdict.checks !== undefined) return "✗ incorrect";
    return `✗ — correct was ${verdict.correct_answer ?? ""}`;
  });

  // Focus the field whenever a fresh prompt is up (keyboard-first UX).
  $effect(() => {
    if (phase === "answering") fieldEl?.focus();
  });

  // P1.5.2 — bind the romaji→kana converter to kana-answer inputs ONLY
  // (grading.rule === "normalized_exact", D-2): the production textarea
  // and meaning inputs are never bound. Hard state-parity invariant:
  // after every input event `answer === element.value`, so the submitted
  // answer always equals the displayed field. Why the sync listener is
  // needed: same-event listeners run in attachment order — Svelte's
  // bind:value listener (attached at element creation) runs FIRST and
  // captures pre-conversion romaji; the library rewrites element.value
  // inside its own listener (attached by bindKanaInput); this listener,
  // attached AFTER bindKanaInput, therefore reads the converted kana
  // back into `answer`. Svelte's own post-tick re-write restores the
  // selection and its render-effect write is equality-guarded (checked
  // against svelte's bind_value source), so the converted value is
  // never clobbered. compositionend sync (attached after the guard's
  // handler in kana-input.ts) refreshes `answer` for IME commits that
  // fire no trailing input event. Cleanup unbinds on prompt advance or
  // rule change; re-renders while already bound are no-ops (the
  // library's bind() is idempotent via data-wanakana-id).
  $effect(() => {
    const element = fieldEl;
    if (!(element instanceof HTMLInputElement)) return;
    if (!prompt || !isKanaAnswerPrompt(prompt)) return;
    bindKanaInput(element);
    const sync = (): void => {
      answer = element.value;
    };
    element.addEventListener("input", sync);
    element.addEventListener("compositionend", sync);
    return () => {
      element.removeEventListener("input", sync);
      element.removeEventListener("compositionend", sync);
      unbindKanaInput(element);
    };
  });

  // Desktop shortcuts 1/2/3 while the self-grade row is up. The field
  // is blurred on submit, so digits never leak into the answer text.
  $effect(() => {
    if (phase !== "checks") return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (event.key === "1") choose("solid");
      else if (event.key === "2") choose("shaky");
      else if (event.key === "3") choose("wrong");
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  onDestroy(() => {
    if (advanceTimer !== null) clearTimeout(advanceTimer);
  });

  /** ⏎ submit — IME-guarded so a composition Enter never submits. */
  function onFieldKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.isComposing || event.metaKey || event.ctrlKey) return;
    if (isProduction && event.shiftKey) return; // Shift+Enter = newline escape
    event.preventDefault();
    submitTyped();
  }

  function submitTyped(): void {
    if (finishing || phase !== "answering" || blank || !prompt) return;
    answerLatencyMs = Date.now() - shownAt;
    if (isProduction) {
      fieldEl?.blur(); // hand the keyboard to the 1/2/3 shortcuts
      phase = "checks";
      return;
    }
    const itemKey = itemKeyFromPromptKey(prompt.prompt_key);
    if (itemKey === null) {
      // Capture keys have no SRS identity (D-5) and are never served
      // in v1 — defensive: skip the round-trip, keep the flow moving.
      advance();
      return;
    }
    void gradeAndAdvance({
      response_uuid: crypto.randomUUID(),
      prompt_key: prompt.prompt_key,
      item_key: itemKey,
      bucket: prompt.bucket,
      answer,
      self_grade: null,
      latency_ms: answerLatencyMs,
    });
  }

  /** Self-grade tap (or 1/2/3) completes a production prompt. */
  function choose(selfGrade: SelfGrade): void {
    if (finishing || phase !== "checks" || !prompt) return;
    const itemKey = itemKeyFromPromptKey(prompt.prompt_key);
    if (itemKey === null) {
      advance();
      return;
    }
    void gradeAndAdvance({
      response_uuid: crypto.randomUUID(),
      prompt_key: prompt.prompt_key,
      item_key: itemKey,
      bucket: prompt.bucket,
      answer,
      self_grade: selfGrade,
      latency_ms: answerLatencyMs,
    });
  }

  /** P1.15 — "I know this": record the skip, advance immediately. */
  function fastSkip(): void {
    if (finishing || !canSkip || !prompt) return;
    // advance() swaps in the next prompt's enabled button synchronously,
    // so a second click in the same burst would skip twice (decision d).
    if (Date.now() - lastSkipAt < 300) return;
    lastSkipAt = Date.now();

    const itemKey = itemKeyFromPromptKey(prompt.prompt_key);
    if (itemKey === null) {
      // Capture keys (D-5) have no SRS identity and are never served
      // in v1 — defensive: keep the flow moving, send nothing.
      advance();
      return;
    }

    const send = sendResponses({
      session_uuid: session.session_uuid,
      responses: [
        {
          response_uuid: crypto.randomUUID(),
          prompt_key: prompt.prompt_key,
          item_key: itemKey,
          bucket: prompt.bucket,
          kind_hint: "fast_skip",
          latency_ms: Date.now() - shownAt,
        },
      ],
    }).catch((error: unknown) => {
      // Phase 1 is online-only (local dev); Phase 2's queue owns retry.
      console.error("fast-skip not recorded:", error);
    });
    inflight = send;
    void send.finally(() => {
      inflight = null;
    });

    advance(); // no verdict window — the skip IS the advance (decision d)
  }

  /**
   * Send one response and open the verdict window. The timer starts
   * NOW (decision c): even if the call hangs, the screen advances at
   * VERDICT_MS — the network can never block the next prompt. A late
   * result only paints while this prompt's window is still open.
   */
  function gradeAndAdvance(item: ResponsesRequest["responses"][number]): Promise<void> {
    const myIndex = index;
    let windowClosed = false;
    phase = "verdict";
    verdict = null;
    if (advanceTimer !== null) clearTimeout(advanceTimer);
    advanceTimer = setTimeout(() => {
      windowClosed = true;
      advance();
    }, VERDICT_MS);

    const send = sendResponses({ session_uuid: session.session_uuid, responses: [item] })
      .then(({ results }) => {
        if (windowClosed || index !== myIndex || phase !== "verdict") return;
        verdict = results[0] ?? null;
      })
      .catch((error: unknown) => {
        // Phase 1 is online-only (local dev); Phase 2 replaces this
        // with the IndexedDB queue + retry.
        console.error("response not graded:", error);
      });
    inflight = send;
    void send.finally(() => {
      inflight = null;
    });
    return send;
  }

  function advance(): void {
    if (advanceTimer !== null) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
    if (finishing) return;
    if (index + 1 >= total) {
      void finish();
      return;
    }
    index += 1;
    answer = "";
    verdict = null;
    phase = "answering";
    shownAt = Date.now();
  }

  /**
   * Both flows end here: last prompt (from advance) or confirmed exit.
   * Waits for the in-flight response so its row exists before the
   * summary is computed. `null` = the complete call failed; P1.14
   * renders that degraded case.
   */
  async function finish(): Promise<void> {
    if (finishing) return;
    finishing = true;
    if (advanceTimer !== null) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
    if (inflight !== null) {
      try {
        await inflight;
      } catch {
        // already logged in gradeAndAdvance
      }
    }
    let result: SessionCompleteResponse | null = null;
    try {
      result = await completeSession({
        session_uuid: session.session_uuid,
        duration_sec: Math.max(0, Math.round((Date.now() - enteredAt) / 1000)),
      });
    } catch (error) {
      console.error("session completion failed:", error);
    }
    oncomplete(result);
  }

  /** ✕ → confirm → partial session saved → Done-lite (UX.md). */
  function requestExit(): void {
    if (finishing) return;
    if (!window.confirm("Exit this session? What you've answered so far is saved.")) return;
    void finish();
  }
</script>

<header>
  <span class="count">{index + 1}/{total}</span>
  <span class="bar" aria-hidden="true">
    <span class="fill" style="width: {progress}%"></span>
  </span>
  <button type="button" class="exit" onclick={requestExit} aria-label="Exit session">✕</button>
</header>

<main>
  {#if prompt}
    <p class="chip">{chip}</p>
    {#if isProduction}
      <p class="instruction">
        {prompt.instruction}{#if productionHint} <span class="hint">{productionHint}</span>{/if}
      </p>
    {:else}
      {#if prompt.stimulus}
        <p class="stimulus">{prompt.stimulus}</p>
      {/if}
      <p class="instruction">{prompt.instruction}</p>
    {/if}

    <div class="field">
      {#if isProduction}
        <textarea
          bind:this={fieldEl}
          bind:value={answer}
          readonly={phase !== "answering"}
          onkeydown={onFieldKeydown}
          aria-label={prompt.instruction}
          rows="2"
        ></textarea>
      {:else}
        <input
          bind:this={fieldEl}
          bind:value={answer}
          readonly={phase !== "answering"}
          onkeydown={onFieldKeydown}
          aria-label={prompt.instruction}
          autocomplete="off"
          spellcheck="false"
        />
      {/if}
      {#if phase === "answering"}
        <button
          type="button"
          class="submit"
          onclick={submitTyped}
          disabled={blank}
          aria-label="Submit answer"
        >⏎</button>
      {/if}
    </div>

    {#if canSkip}
      <button type="button" class="skip" onclick={fastSkip}>I know this</button>
    {/if}

    {#if phase === "checks"}
      {#each previewChecks as check}
        <p class="check">{check.passed ? "✓ contains" : "✗ missing"} {check.value}</p>
      {/each}
      <p class="selfgrade-q">Was that solid?</p>
      <div class="selfgrade">
        <button type="button" onclick={() => choose("solid")} aria-keyshortcuts="1">
          <kbd>1</kbd> ✓ solid
        </button>
        <button type="button" onclick={() => choose("shaky")} aria-keyshortcuts="2">
          <kbd>2</kbd> ~ shaky
        </button>
        <button type="button" onclick={() => choose("wrong")} aria-keyshortcuts="3">
          <kbd>3</kbd> ✗ wrong
        </button>
      </div>
    {/if}

    {#if phase === "verdict" && verdict?.checks}
      {#each verdict.checks as check}
        <p class="check">{check.passed ? "✓ contains" : "✗ missing"} {check.value}</p>
      {/each}
    {/if}
  {/if}

  <p class="verdict" role="status" aria-live="polite">{verdictText}</p>
</main>

<style>
  header {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.9rem;
    background: Canvas;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    font-size: 0.9rem;
    color: color-mix(in srgb, CanvasText 65%, transparent);
    z-index: 1;
  }

  .count {
    font-variant-numeric: tabular-nums;
  }

  .bar {
    flex: 1;
    display: block;
    height: 0.4rem;
    border-radius: 999px;
    background: color-mix(in srgb, CanvasText 14%, transparent);
    overflow: hidden;
  }

  .fill {
    display: block;
    height: 100%;
    background: LinkText;
    border-radius: inherit;
    transition: width 150ms ease;
  }

  .exit {
    border: none;
    background: none;
    font: inherit;
    font-size: 1rem;
    color: inherit;
    cursor: pointer;
    padding: 0.35rem 0.5rem;
    line-height: 1;
    border-radius: 0.4rem;
  }

  .exit:hover {
    background: color-mix(in srgb, CanvasText 10%, transparent);
  }

  .exit:focus-visible {
    outline: 2px solid Highlight;
    outline-offset: 2px;
  }

  main {
    min-height: 100dvh;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.9rem;
    padding: 3.5rem 1rem 2rem;
    text-align: center;
  }

  .chip {
    margin: 0;
    font-size: 0.85rem;
    color: color-mix(in srgb, CanvasText 55%, transparent);
  }

  .instruction {
    margin: 0;
    font-size: 1.05rem;
  }

  .hint {
    color: color-mix(in srgb, CanvasText 60%, transparent);
  }

  .stimulus {
    margin: 0;
    font-size: 2.5rem;
    line-height: 1.8;
  }

  .field {
    position: relative;
    width: min(90vw, 30rem);
  }

  input,
  textarea {
    box-sizing: border-box;
    width: 100%;
    font: inherit;
    font-size: 1.25rem;
    line-height: 1.8;
    padding: 0.75rem 3rem 0.75rem 1rem;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    border-radius: 0.75rem;
    background: Field;
    color: FieldText;
  }

  textarea {
    display: block;
    resize: vertical;
    min-height: 4.5rem;
  }

  input:focus-visible,
  textarea:focus-visible {
    outline: 2px solid Highlight;
    outline-offset: 1px;
    border-color: LinkText;
  }

  input[readonly],
  textarea[readonly] {
    opacity: 0.9;
  }

  .submit {
    position: absolute;
    right: 0.5rem;
    top: 50%;
    transform: translateY(-50%);
    border: none;
    background: none;
    font-size: 1.1rem;
    color: color-mix(in srgb, CanvasText 60%, transparent);
    cursor: pointer;
    padding: 0.4rem 0.55rem;
    border-radius: 0.4rem;
  }

  .submit:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .submit:focus-visible {
    outline: 2px solid Highlight;
    outline-offset: 1px;
  }

  /* P1.15 — deliberately secondary to the answer field (UX.md §2). */
  .skip {
    margin: 0.2rem 0 0;
    border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
    border-radius: 0.75rem;
    background: none;
    font: inherit;
    font-size: 0.95rem;
    color: color-mix(in srgb, CanvasText 55%, transparent);
    cursor: pointer;
    min-height: 3rem;
    padding: 0.5rem 1.1rem;
  }

  .skip:hover {
    background: color-mix(in srgb, CanvasText 6%, transparent);
    color: color-mix(in srgb, CanvasText 75%, transparent);
  }

  .skip:focus-visible {
    outline: 2px solid Highlight;
    outline-offset: 2px;
  }

  .check {
    margin: 0;
    font-size: 1rem;
    color: color-mix(in srgb, CanvasText 75%, transparent);
  }

  .selfgrade-q {
    margin: 0;
    font-size: 1rem;
    color: color-mix(in srgb, CanvasText 65%, transparent);
  }

  .selfgrade {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  .selfgrade button {
    font: inherit;
    font-size: 1.05rem;
    min-height: 3rem;
    padding: 0.5rem 1.1rem;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    border-radius: 0.75rem;
    background: ButtonFace;
    color: ButtonText;
    cursor: pointer;
  }

  .selfgrade button:hover {
    background: color-mix(in srgb, LinkText 12%, ButtonFace);
  }

  .selfgrade button:focus-visible {
    outline: 2px solid Highlight;
    outline-offset: 2px;
  }

  kbd {
    font-family: inherit;
    font-size: 0.8rem;
    color: color-mix(in srgb, CanvasText 60%, transparent);
    border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
    border-radius: 0.3rem;
    padding: 0 0.3rem;
  }

  .verdict {
    margin: 0.25rem 0 0;
    min-height: 1.4em;
    font-size: 1.15rem;
  }

  .verdict:empty {
    display: none;
  }
</style>
