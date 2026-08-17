- Prefers using Command Code's built-in hook system (`onStop` with `{continue: true}`, `prepareNextTurn` for model switching) over shelling out to external API calls (e.g., `curl`). When the framework provides a seam, use it instead of reaching for raw HTTP. Confidence: 0.9
- Prefers mod UI output to be clearly attributed to the mod that produced it and avoids redundant display where the same content appears in multiple places. When the platform's notification mechanism already signals the mod source, internal labels inside the notification (e.g., `~ hooku ~`) become redundant and should be removed. Confidence: 0.9
- Prefers concrete, data-driven LLM prompts that include the actual source text/content rather than vague descriptions. When asking a model to transform or respond to something, pipe the real data into the prompt instead of relying on the model to guess from context. Confidence: 0.7

- Prefers `cmd.ui.notify()` for transient status/loading messages (e.g., "writing hooku with <model>...") and custom renderers (`addRenderer` / `showEntry`) for final styled mod output. Notify is for progress; renderer is for the finished result. Confidence: 0.8
- Prefers `cmd.ui.setStatus` over `cmd.ui.notify` for persistent on-screen mod messaging and status (e.g., a mascot's running commentary and mood). `setStatus` is for persistent footer presence; `notify` is for one-shot transient messages. The choice should be deliberate — don't use `notify` where `setStatus` gives the right persistence. Confidence: 0.8

- Prefers minimal configuration surface — remove flags that don't earn their keep rather than keeping them "just in case." If only one behavior is needed (e.g., always scoped to the run), don't expose a flag for it. Confidence: 0.6

- Uses underscore as thousands separator in numeric literals (e.g., `3_000` instead of `3000`) for readability in JavaScript/TypeScript. Confidence: 0.8

- When feeding long text to an LLM (e.g., prior run output), prefers distributed sampling from start, middle, and end over naive head truncation — gives the model representative coverage of the full content. Confidence: 0.7

- Prefers minimal code — strips unused machinery (e.g., custom renderers) and simplifies logic to its smallest correct form, such as a plain presence check (`if (haiku)`) instead of splitting/filtering/slicing text when the extra parsing isn't needed. Confidence: 0.7

- Prefers example/showcase code to be commented with the framework's key hooks and capabilities explained (e.g., what `addFlag`, `onStop` with `{continue: true}`, `prepareNextTurn`, and `cmd.ui.notify` demonstrate), not just what the code does mechanically. The "most important" comments are the ones that teach the API surface. Confidence: 0.8

- Treats this repo's real purpose as showcasing the Command Code mod API — "more important than the mod is how it showcases command code mods." Documentation (README) should be framed around what each mod demonstrates of the API surface, not the mod's own features. Confidence: 0.9

- Requires the README to always describe every mod in the repo: each mod in `.commandcode/mods/` must have a corresponding README section, and any new mod must be documented there. Documentation completeness is a standing rule, not optional. Confidence: 0.9
- Prefers README documentation to explain exact behavioral mechanics rather than vague phrasing — e.g., when describing the task-journal extraction gate, spell out the precise rule (≥2 files changed, or 1 file changed plus a test/check run) in both the intro and the "How it works" step, instead of leaving "meaningful run" undefined. Confidence: 0.6
- Prefers behavioral mechanics documented in both the README and the mod source comments: when a behavior (e.g., the meaningful-run gate) is explained in the README, the mod's header comment and the relevant hook's doc comment (e.g., `onStop`) should carry the same explanation, with a pointer to the defining constant — so code and README stay in sync and the code is self-documenting. Confidence: 0.7

- Prefers thorough discovery before creating or changing configuration: glob for existing files, consult knowledge base topics, read directories, check current config values, shell-command to inspect, web-search and web-fetch for docs — exhaust available information before writing anything. Confidence: 0.7

- Prefers explicit intent in configuration files, even at the cost of some redundancy. When a permission or setting is technically covered by another rule (e.g., `Edit` already covers `Write`), it's still worth including the redundant rule if it makes the intended behavior more obvious to a reader. Confidence: 0.5

- Prefers namespaced flag names for Command Code mods — every flag should use a `modname.` prefix (e.g., `weather.city`, `clock.tz1`) to prevent collisions between mods. Bare flag names like `city` without a namespace prefix are a convention violation even if they happen to work. Confidence: 0.8

- Prefers widget/UI element registration to happen inside lifecycle hooks (especially `onSessionStart`) rather than at module-import time. Creating widgets at module load causes them to appear before a session exists; deferring to `onSessionStart` ensures proper lifecycle alignment. Confidence: 0.7

- Prefers a single `cmd.hooks()` call per mod that registers all hooks together, rather than spreading hook registrations across multiple invocations. Confidence: 0.5

- Prefers storing durable knowledge/facts in a small local JSONL file (created on first write) rather than a database or cloud service — lightweight, human-inspectable, zero external dependencies. Confidence: 0.8
- Wants the memory store files (.commandcode/project-brain.jsonl and task-journal.jsonl) committed to git rather than gitignored, so the history of learned facts and episodes is kept across sessions — the memory files are treated as valuable, trackable project artifacts, not throwaway local state. Confidence: 0.9

- Prefers every stored fact/knowledge entry to carry provenance metadata — the fact itself plus evidence, source files/commit, timestamp, and confidence — so nothing is remembered without a verifiable basis. Confidence: 0.8

- Prefers relevance-filtered context injection: when injecting stored knowledge into a prompt, include only the facts relevant to the current turn, never the whole store. Unrelated facts should stay out to keep context minimal and task-scoped. Confidence: 0.8

- Prefers treating code as the source of truth for derived knowledge: learned facts/memories must be invalidated (marked stale) when their supporting code changes, rather than blindly trusted or left to go stale. Confidence: 0.9

- Prefers learning durable project knowledge automatically by observing what the agent actually does, rather than requiring humans to hand-maintain it all — e.g., a mod that complements AGENTS.md with machine-discovered facts. Confidence: 0.7

- Prefers "experience over transcript" for stored memory: episodic entries should be compressed structured episodes (task, outcome, approaches tried, failures, solution, tests, lesson) that explicitly drop every command, every file read, temporary hypotheses, and conversational chatter. Confidence: 0.7

- Prefers keeping episodic memory separate from durable factual knowledge: if an episode reveals a durable repository fact, that fact should graduate into a dedicated facts store (e.g., Project Brain) rather than permanently living only in the episode journal. Confidence: 0.65

- Prefers instrumenting memory/retrieval systems with a usefulness feedback loop — record when a stored episode was retrieved and whether the task subsequently succeeded, as the training signal for a future learned retrieval policy. Confidence: 0.6
- Prefers memory-mod failure paths to be observable rather than silent: unparseable extraction output, failed validation, or a store write error should each log the reason to stderr and surface a `cmd.ui.notify`, and the phase-2 ingest call should be wrapped in try/catch — no episode may vanish without a trace. Confidence: 0.7
- Prefers backfilling memory data that a bug dropped rather than accepting the loss — e.g., manually appending an earlier extraction episode to task-journal.jsonl so the journal history is complete, rather than starting the store empty. Confidence: 0.6
- Prefers verifying mod behavior with a real end-to-end probe run (headless `cmd -p` that actually changes a file, fires the hooks, and is inspected via the NDJSON event stream) rather than trusting code reading or static analysis. Confidence: 0.5

- Prefers that retrieved historical experience be injected as non-authoritative context — labeled as historical, not current truth, and verified against the present code. It should influence exploration, never override the repository. Confidence: 0.65
