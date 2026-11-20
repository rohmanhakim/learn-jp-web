# UX Specification

## Design intent

One surface, zero decisions. The app must feel like a vending machine:
press the button, receive the practice, walk away. No dashboard, no
settings visible before practicing, no interpretation required after.

**Hard rule:** no screen may sit between opening the app and the first
prompt except Home's single Start button.

## Screen inventory

```
Home ──▶ Session ──▶ Done
          │  ▲
          └──┘  (next prompt, automatic)
```

### 1. Home

```
┌──────────────────────────────┐
│                              │
│        learn-jp-web          │
│        🔥 4-day streak       │
│                              │
│      ┌──────────────────┐    │
│      │   Start session  │    │  ← one primary action
│      └──────────────────┘    │
│                              │
│   Last: yesterday · 12 min   │  ← glanceable, not interactive
│                              │
└──────────────────────────────┘
```

- Primary CTA fills the screen's focus. Everything else is muted text.
- Loading state replaces CTA label ("Preparing…"), never a spinner-only
  screen.
- Offline with cached snapshot: CTA stays live. Offline with no
  snapshot: CTA becomes "Connect once to prepare your session".
- Optional thin footer: streak, due count. **No charts, no stats pages
  in v1.**

### 2. Session

One prompt at a time. The screen is the prompt — nothing else.

**Header (fixed, slim):**
```
3/12   ▓▓▓▓▓░░░░░░   ✕
```
progress bar + exit (exit = confirm → auto-save partial session;
never a ceremony).

**Recall prompt (typed answer):**
```
        review · vocab

            毎朝

     Type the meaning
  ┌──────────────────────────────┐
  │ every morning            ⏎   │
  └──────────────────────────────┘
```
After submit (online): inline verdict for ~1.2 s, then next prompt.

**First-run fast-skip (session 1 only):** while the snapshot carries
`fast_skip_available`, every recall prompt also shows a muted **I know
this** button under the field (never on production prompts). One tap
records the skip server-side — no grading UI, no self-grade, no
verdict — and jumps straight to the next prompt; the skipped item is
suspended and returns only 30 days later. From session 2 onward the
button is gone (LEARNING-DESIGN §7).

**Reading prompt (production, with self-grade):**
```
        new · writing

  Write a sentence using 合図 (signal)
  ┌──────────────────────────────┐
  │ 彼は合図をくれました。           │
  └──────────────────────────────┘
     Was that solid?
  [ ✓ solid ] [ ~ shaky ] [ ✗ wrong ]
```
Self-grade appears only after submit; it is part of grading, not a
pre-condition. Deterministic checks (must-contain etc.) show inline as
`✓ contains 合図` / `✗ missing 合図` regardless of self-grade.

**Reading passage + question:**
```
        reading · N4

  ┌─ 公園の静かな日 ──────────────┐
  │  公園には人が少ない…           │  ← passage stays on top,
  └─────────────────────────────┘     question below
        公園の様子として正しいものは？
  ( ) 子供たちが遊んでいる
  ( ) 静かで、読書をしている人がいる   ← tap to answer
  ( ) 何かのイベントがある

  [ + unknown word?  tap it in the passage ]
```
- Tapping an unknown word in the passage body opens a mini-sheet:
  "Add to your queue?" → one tap, done. This is the entire unknown-word
  capture UX.
- Comprehension answer = choice tap; inline verdict, then next.

**Offline mode:** identical UI. Verdicts are queued (brief "queued"
badge instead of immediate verdict) and the summary reflects everything
once synced; if online at completion, no visible difference.

**Done transition:** after the last prompt, the Session screen is
replaced by Done — never back to Home in between.

### 3. Done

```
┌──────────────────────────────┐
│        Session complete      │
│                              │
│   reviews   8/9              │
│   new words 2/3              │
│   reading   3/3 + 2 saved    │
│   writing   solid            │
│   🔥 5-day streak            │
│                              │
│   Next: 8 reviews · 3 new    │
│   (kanji readings are your   │
│    weakest right now)        │
│                              │
│        [ Done ]              │
└──────────────────────────────┘
```

- Shows what happened + one sentence of adaptation ("the system
  adjusted"). This is the entire feedback loop the user needs.
- No scores to interpret, no graphs, no share sheets.

## Interaction states

| State | Behavior |
|---|---|
| Start (online) | snapshot fetched → straight into prompt 1 |
| Start (offline, snapshot cached) | straight into prompt 1 |
| Start (offline, no snapshot) | CTA explains: connect once |
| Answer submitted (online) | immediate grade shown, next prompt |
| Answer submitted (offline) | "queued" badge, next prompt |
| Mid-session network loss | seamless — answers queue silently |
| Exit mid-session | confirm → partial session saved → Done-lite summary |
| App killed mid-session | snapshot + queue survive in IndexedDB; reopen resumes at the right prompt |
| Sync conflict | impossible by design (UUID idempotency, server authoritative) |

## Grading display conventions

- Inline verdicts are short and non-blocking: `✓ correct` / `✗ — correct
  was まいあさ` (recall shows the answer when wrong — learning moment).
- Self-grade buttons are large (thumb-friendly), keyboard-reachable
  (`1/2/3` shortcuts on desktop).
- Never block on network to show the next prompt when offline.

## Input considerations

- Japanese entry uses the platform IME in a plain `<input>`/`<textarea>`
  — no custom keypad, no candidate/IME widget (DECISIONS D14).
- **Kana-answer fields convert romaji as you type (Phase 1.5):** the
  reading and kanji-reading prompts (`normalized_exact`) bind a
  transliteration layer (`wanakana`, `IMEMode: 'toHiragana'`) so a
  device without a Japanese IME can answer `maiasa` → `まいあさ`.
  It is invisible mechanics — no suggestions, no dictionary, no
  toggle — and it must never run on meaning (`keyword`, English) or
  production fields. Platform-IME composition is never interrupted
  (no conversion mid-composition).
- Normalization before grading happens server-side (full/half width,
  katakana↔hiragana for readings) — the client sends what is in the
  field, un-normalized (the field may hold converted kana; NFKC/width
  folding is still server-side only).

## Visual style (guidance, not mandate)

- Readable Japanese typography: line-height ≥ 1.8 for passage bodies,
  generous font size for kanji stimuli, system JP font stack
  (`"Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif`).
- Light/dark via `prefers-color-scheme`.
- Large tap targets; the app is phone-first even though it runs on
  desktop.
- Keep the aesthetic calm and empty — the prompt is the content.

## Accessibility baseline

- All interactive elements keyboard-operable (desktop users type
  answers anyway).
- Focus visible; verdicts announced via `aria-live="polite"`.
- Passage text selectable (users may long-press-copy unknown words as a
  fallback to tap-capture).