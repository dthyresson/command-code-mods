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

## Going further

hooku covers the core API surface, but mods can do more: register slash
commands, observe events, intercept input, add custom renderers, and register
entire model providers. New mods in this repo should each showcase one of
those capabilities.
