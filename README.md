# command-code-mods

A collection of Command Code mods — tiny plugins that extend the agent loop.

The point of this repo isn't the mods themselves; it's what they demonstrate.
Each mod is a minimal, readable example of the Command Code mod API, so you
can lift the patterns into your own mods. **hooku** is the flagship showcase:
it touches nearly every capability a mod can use.

## What a mod is

A mod is a TypeScript file that exports a single function receiving the
`ModApi` (the `cmd` object). Everything a mod can do hangs off that object:
register flags, attach hooks, and surface UI feedback.

## hooku (`hook` + `haiku`)

Composes a three-line haiku poem about every run's output. Entirely useless,
therefore essential.

### What it demonstrates

- **`addFlag` — mod-defined configuration.** hooku registers `hooku.enabled`
  and `hooku.model` as first-class CLI options, and reads them at runtime via
  `cmd.getFlag`. Users can flip them on the command line:
  `--mod-option hooku.enabled=false`.
- **`onStop` with `{continue: true}` — injecting work into the agent loop.**
  When a run would end, `onStop` forces one extra turn with a custom prompt
  (`reason`). This is the core mechanism for follow-up work — summarization,
  post-processing, anything you want to run after the assistant finishes.
- **Two-phase state machine.** Because the hook fires again on the turn it
  injected, hooku uses a `haikuPending` flag to distinguish phase 1 (kick off
  the haiku) from phase 2 (the haiku came back).
- **`prepareNextTurn` — model switching.** Before that injected turn runs,
  hooku routes it to a cheaper model via `prepareNextTurn`, keeping the
  expensive main-loop model on real work.
- **`cmd.ui.notify` — transient UI feedback.** Status ("writing hooku...")
  and outcome ("done") go through notify, so the mod never pollutes the run's
  own output.
- **Data shaping.** The run output is sampled (start / middle / end) before
  being fed to the haiku model — a small, real example of preparing data for
  a follow-up LLM call.

### Flags

- `hooku.enabled` (boolean, default `true`) — toggle haiku generation.
- `hooku.model` (string, default `deepseek/deepseek-v4-flash`) — LLM model for haiku generation.

```bash
# Default: enabled, deepseek/deepseek-v4-flash
cmd

# Disable the haiku
cmd --mod-option hooku.enabled=false

# Use a different model
cmd --mod-option hooku.model=claude-haiku-4-5-20251001
```

## tamagotchi

A virtual pet that lives in the TUI footer and reacts to the agent's
lifecycle — it wakes on session start, gets busy during tool calls, frets
after failures (or red tests), celebrates green tests, and sleeps when the
session ends.

### What it demonstrates

- **`onSessionStart` / `onSessionEnd` — cross-agent lifecycle hooks.** The
  once-per-session wake/sleep bookends. They carry a typed `source` / `reason`
  (resume vs. startup, replaced vs. shutdown) the bare `session_start` /
  `session_shutdown` events don't — so a resumed session can "pick up where
  it left off" instead of just waking.
- **`beforeToolCall` + `afterToolCall` — the pre/post tool seams.**
  `beforeToolCall` sets a busy, category-aware "starting" line; `afterToolCall`
  reacts to `isError` and sniffs `result` for green/red test-runner output,
  then settles back to idle. Both return `undefined` (no mutation) — a hook
  is allowed to only observe.
- **Session time & system time tracking —** The pet maintains both a session clock (how long the session has run) and a system clock (current local hour). Late-night hours bias the pet toward drowsy sleepy variants; early mornings inject energetic wake-up lines. Turns exceeding 15 s trigger a slow-turn alert; sessions past ~10 min ramp fatigue messages. State deduplication ensures the footer never flickers through redundant updates.
- **Tool-category messaging.** Reads 📖, writes ✏️, commands 🪄, and shell 💻 each get their own fun before/after sets (picked at random); when the pet is sleepy the messages swap to tired/fatigued variants so the pet "becomes" the tool it's using.
- **`cmd.ui.setStatus` — messaging and status in one segment.** The pet's
  voice is a single per-mod footer line, replaced on every change — no
  `notify`. (Headless: stored, rendered nowhere.)
- **`addFlag` — mod-defined configuration.** Name and idle emoji are
  first-class CLI options, read back at runtime via `cmd.getFlag`.

### Flags

- `tamagotchi.name` (string, default `Pixel`) — the pet's name.
- `tamagotchi.emoji` (string, default `🐣`) — the pet's awake/idle emoji.

```bash
# Defaults: Pixel 🐣
cmd

# Name your pet and pick its idle face
cmd --mod-option tamagotchi.name=Mochi --mod-option tamagotchi.emoji=🐱
```

## clock

A persistent multi-zone world clock displayed in the TUI footer. Shows your local
time plus 1–3 configurable extra zones (London, LA, Sydney by default), each with
a sun/moon emoji that matches the actual hour. Updates live every ~8 seconds and
refreshes right before every tool call.

### What it demonstrates

- **`addFlag` + `getFlag` — slot-based optional configuration.** The clock exposes
  five flags: `format` (12 h / 24 h) and `tz1`/`tz2`/`tz3` (timezone strings).
  Each slot's flag defaults to an empty string; when empty the mod falls back to
  a built-in default (`Europe/London`, `America/Los_Angeles`, `Australia/Sydney`).
  This pattern lets you expose powerful per-slot options without forcing the user
  to configure them all.
- **`onSessionStart` — once-per-session lifecycle bookend.** Fires when a session
  begins (startup or resume). The clock uses this to kick off its interval timer
  and render immediately so the clock appears on-screen without waiting for the
  first tick. The hook receives a typed `source` param (`'startup'` vs `'resume'`)
  the bare `session_start` event doesn't carry.
- **`onSessionEnd` — once-per-session teardown bookend.** Fires when a session ends
  (interrupted, replaced, finished). The clock clears its interval here to prevent
  timer leaks across sessions. Manual cleanup (vs. a Disposable handle from
  `widget`/`addRenderer`) — appropriate when you own a non-harness resource directly.
- **`beforeToolCall` — reactive hook on every tool invocation.** Secondary freshness
  mechanism. While the interval ticks independently, this hook guarantees a refresh
  right before the model observes any tool result. Useful for rapid tool chains
  where users want a real-time ticking feel. Returns `undefined` (no mutation):
  hooks can also block calls, rewrite input, or terminate the run.
- **`cmd.ui.setStatus` — persistent footer segment.** Not transient `notify`. One
  segment per mod painted side-by-side in load order beneath the input panel. New
  calls replace old text; whitespace-only clears it. Headless: stored, rendered
  nowhere. Combined with the `beforeToolCall` hook and interval timer, creates a
  clock that never stales whether the agent is idle or deep in tool calls.
- **Slash commands** — `/clock` shows current times inline; `/clock format` checks
  the format flag; `/clock tz1|2|3 <zone>` shows how to set slots via CLI flags.
  Commands return `{message}` (info row data), not `{prompt}` (automated turns) or
  nothing (pure side effect).
- **Intl.DateTimeFormat — zero-dependency timezone handling.** Native locale-aware
  formatting, timezone parsing, and offset extraction. No external packages needed.

### Emoji system

EMOJIS[0–23] maps each local hour to a celestial body: ☀️ anchors midday (noon =
full sun ☀️), 🌕 anchors midnight (midnight = full moon 🌕). Hours between cycle
through waxing/waning crescent phases as daylight fades or increases — pure sun
and moon, no clouds or stars. Each zone computes its own emoji from its local hour.

### Flags

- `clock.format` (string, default `''` → 24 h) — `'12'` switches to 12-hour format.
- `clock.tz1` (string, default `'Europe/London'`) — optional timezone slot 1.
- `clock.tz2` (string, default `'America/Los_Angeles'`) — optional timezone slot 2.
- `clock.tz3` (string, default `'Australia/Sydney'`) — optional timezone slot 3.

```bash
# Defaults: local + London + LA + Sydney, 24 h format
cmd

# Use Tokyo instead of LA, and 12-hour format
cmd --mod-option clock.tz2=Asia/Tokyo --mod-option clock.format=12

# Disable a slot by passing an empty value
cmd --mod-option clock.tz3=""   # removes Sydney
```

## hex-color-swatch (#fefefe → ██)

A [Command Code](https://commandcode.ai) mod that makes hex colors visible in
your terminal by rendering true-color ANSI swatches.

### What it does

Two jobs, nothing else:

#### 1. Inline swatches in your input

When you **type** a hex color like `#fefefe`, the prompt is transformed before
the model sees it — each color becomes a 2-wide solid box painted the actual
color, inline:

```
type:    use #fefefe and #0af for the theme
becomes: use ██ #fefefe and ██ #0af for the theme
```

The model sees the annotated color too, so it can reason about it.

#### 2. Color list from model output

When the model's **reply** contains hex colors, the response is *not*
rewritten or echoed back. Instead, each unique color is extracted and rendered
as a compact list of swatches in the feed:

```
██ #fefefe ██ #3b82f6 ██ #00aaff
```

The model's original answer stays exactly as written — the list is just a
visual aid so you can see the colors at a glance.

### What it demonstrates

- **`hooks.transformInput` — annotate typed input inline.** Runs on every keystroke
  (after a run starts). Hex colors in the prompt get painted `██` blocks before the model
  ever sees them. Returns `{ action: "transform", text }`.
- **`hooks.onStop` — post-run extraction.** Fires when the assistant finishes; scans the
  final assistant text for hex colors using a regex that only matches real 3/6-digit codes
  (`#12345` is ignored, CSS keywords are safe). Calls `cmd.showEntry` with extracted colors.
- **`cmd.addRenderer('hex-colors', …)` + `cmd.showEntry` — custom feed renderer.** A
  single-line renderer that joins deduplicated, normalized swatches into a compact row.

### Example prompts

Ask for colors in any way and the mod renders a swatch list from the reply:

**Rainbow**
> Give me the hex colors of a rainbow

**Color variants**
> Show me 5 shades of blue from dark to light with their hex codes

**Gradient builder**
> Give me a hex gradient from #ff6b6b to #4ecdc4 in 6 steps

**Sports team colors**
> Do a web search for the San Diego Padres' official colors and list their hex codes
> Search for the Vegas Golden Knights' team colors and show them as hex codes
> What are the MLB team colors? List a few teams with their brand hexes

**More ideas**
> Give me the Tailwind 500 palette
> What's the hex for bright green?
> List 10 material design colors

### Shwocase

#### Seattle Kraken Colors

<img width="973" height="778" alt="image" src="https://github.com/user-attachments/assets/28bc0e9d-760b-4139-b680-573c3f42760d" />

#### Gradient

<img width="1341" height="566" alt="image" src="https://github.com/user-attachments/assets/90f32cf3-e57e-4683-9327-f2b8f0de5ab1" />

#### TailwindCSS Colors

<img width="1154" height="360" alt="image" src="https://github.com/user-attachments/assets/6a8621c9-2c86-4c08-9d1b-f2de2231f7de" />

#### Inline Prompt Transform

<img width="1016" height="405" alt="image" src="https://github.com/user-attachments/assets/f714a29a-f204-4b05-9242-e1fb74cdf667" />

### Install

#### Project mod (trusted workspace)

Copy to `.commandcode/mods/hex-color-swatch.ts` (this repo already has it
there). It loads once the workspace is trusted.

#### Personal mod

```bash
mkdir -p ~/.commandcode/mods
cp .commandcode/mods/hex-color-swatch.ts ~/.commandcode/mods/
```

#### As a package

The repo ships a `package.json` with a `commandcode` mods entry, so it can be
installed from a local dir:

```bash
cmd mods add ./path/to/this-repo
```

### Load & verify

```bash
# Load without installing
cmd --mod ./.commandcode/mods/hex-color-swatch.ts

# Confirm it registered (no warnings)
cmd mods list

# Reload to pick up changes
/reload
```

### How it works

- `hooks.transformInput` — annotate typed prompts inline.
- `hooks.onStop` — when the run finishes, extract hex colors from the model's
  final text.
- `cmd.addRenderer('hex-colors', …)` + `cmd.showEntry` — render the extracted
  colors as a swatch list feed row.

### Details

- **Short hex** — `#0af` works and is expanded to `#00aaff` in the list.
- **Deduplication** — `#FEFEFE` and `#fefefe` count as one color.
- **Safe matching** — only real 3/6-digit hex codes match (`#12345` is not a
  color); no false positives on CSS keywords.
- **The response is never altered** — the color list is a separate feed row.

### Requirements

- A terminal with 24-bit ("truecolor") ANSI support (most modern terminals).
  Without it, the `██` renders as a plain colored glyph rather than a true
  color swatch.

## Going further

hooku covers the core mutating surface; tamagotchi covers the tool-hook +
UI-status surface (`beforeToolCall`/`afterToolCall`, the lifecycle hooks, and
`cmd.ui.setStatus`). Mods can do more still: register slash commands,
intercept input, add custom renderers, and register entire model providers.
New mods in this repo should each showcase one of those capabilities.
