# command-code-mods

A collection of Command Code mods — tiny plugins that extend the agent loop.

## Mods

### hooku (`hook` + `haiku`)

Composes a three-line haiku poem about every run's output. Entirely useless, therefore essential.

When a run would end, hooku's `onStop` hook forces one extra turn — it notifies "writing hooku with <model>...", swaps to the configured model via `prepareNextTurn`, feeds the run's output as haiku source material, then renders the poem via a custom renderer.

**Flags:**
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
