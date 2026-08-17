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
- Skeptical of pure keyword/substring matching for memory retrieval — wants the injected brain/journal items to be the most relevant and helpful ones, not just the fastest lexical hits; values retrieval quality over raw speed and is open to smarter scoring (matching richer fields like solution/lesson, IDF weighting, field weighting, cheap-model re-rank) rather than settling for naive matching. Explicitly praised project-brain's improved relevant-item selection and asked for the same quality in task-journal. Confidence: 0.75

- Prefers treating code as the source of truth for derived knowledge: learned facts/memories must be invalidated (marked stale) when their supporting code changes, rather than blindly trusted or left to go stale. Confidence: 0.9

- Prefers learning durable project knowledge automatically by observing what the agent actually does, rather than requiring humans to hand-maintain it all — e.g., a mod that complements AGENTS.md with machine-discovered facts. Confidence: 0.7

- Prefers "experience over transcript" for stored memory: episodic entries should be compressed structured episodes (task, outcome, approaches tried, failures, solution, tests, lesson) that explicitly drop every command, every file read, temporary hypotheses, and conversational chatter. Confidence: 0.7
- Prefers durable work-summary entries in a structured JSON shape with separate sections for task, summary, outcome, files changed/read, approaches tried (each with result and reason), decisions (each with choice, reason, and rejected alternative), solution, tests run with results, and lesson. Confidence: 0.8
- Prefers memory/fact entries to ground claims in evidence: concrete code quotes or observations tied to exact source locations (file and line numbers) plus a confidence score, so stored facts are verifiable rather than asserted. Confidence: 0.8

- Prefers keeping episodic memory separate from durable factual knowledge: if an episode reveals a durable repository fact, that fact should graduate into a dedicated facts store (e.g., Project Brain) rather than permanently living only in the episode journal. Confidence: 0.65

- Prefers instrumenting memory/retrieval systems with a usefulness feedback loop — record when a stored episode was retrieved and whether the task subsequently succeeded, as the training signal for a future learned retrieval policy. Confidence: 0.6
- Prefers memory-mod failure paths to be observable rather than silent: unparseable extraction output, failed validation, or a store write error should each log the reason to stderr and surface a `cmd.ui.notify`, and the phase-2 ingest call should be wrapped in try/catch — no episode may vanish without a trace. Confidence: 0.7
- Prefers backfilling memory data that a bug dropped rather than accepting the loss — e.g., manually appending an earlier extraction episode to task-journal.jsonl so the journal history is complete, rather than starting the store empty. Confidence: 0.6
- Prefers verifying mod behavior with a real end-to-end probe run (headless `cmd -p` that actually changes a file, fires the hooks, and is inspected via the NDJSON event stream) rather than trusting code reading or static analysis. Confidence: 0.5

- Prefers that retrieved historical experience be injected as non-authoritative context — labeled as historical, not current truth, and verified against the present code. It should influence exploration, never override the repository. Confidence: 0.65
- Prefers memory usage in prompts to be observable: both memory mods (project-brain and task-journal) should `cmd.ui.notify` when their memory items are injected into a prompt (e.g., "🧠 brain: 3 relevant facts injected" / "📓 journal: 2 episodes injected"), so the user can see their memory being used — currently only write/discovery events notify, and injection is silent. Guarded per-run so it fires once per task, not every round. Confidence: 0.85
- Prefers that an injection/usage notification be paired with a way to see exactly what was used: a `cmd.showEntry` feed entry (with a registered `addRenderer`) that lists each injected item in detail — facts with evidence, sources, and confidence; episodes with task, outcome, lesson, decisions, and id — so the user knows precisely which memory items are in play, not just a count. Confidence: 0.8

- Prefers concise explanations when asking for an overview (e.g., "explain concisely how X and Y help with memory and context") — a compact, structured answer that hits the key mechanics and an "in one line" takeaway, rather than an exhaustive walkthrough. Confidence: 0.4

- Wants memory-mod model calls (brain/journal extraction and discovery turns) to be attributable in Command Code's usage reporting — asked whether a custom model/mode label could be sent in the model call so memory usage shows up distinctly from the main agent's. When a product seam doesn't exist for this, accepts the built-in discriminator (distinct model id) plus in-mod self-reporting as the available alternatives. Confidence: 0.5
- Prefers human-friendly relative timestamps in list output ("x mins ago" / "x hrs ago" / "x days ago") for recent entries, falling back to the full YYYY-MM-DD date beyond a threshold window, with the threshold as a named module-level const (RELATIVE_DAYS = 3) rather than an inline magic number. Confidence: 0.8
- Requests UX/formatting features for the memory mods in parallel — the notify-on-injection, the showEntry detail list, and the relative-date list formatting were each asked for in both project-brain and task-journal together, expecting identical, consistent behavior across the two mods. Confidence: 0.55

- Wants the memory mods' heavy maintenance work (brain discovery, journal extraction) to run detached from the main loop — explored running them as background agents or scheduled background tasks rather than in-line via the onStop/prepareNextTurn continuation seam. When told the mod API can't spawn background agents today, accepts the current in-line approach (cheap model via prepareNextTurn) rather than forcing a workaround. Confidence: 0.5
- When a needed capability is missing from Command Code itself (e.g., mods can't run things in the background), prefers to file a formal feature request upstream on the project's GitHub issues rather than settling for the local workaround — asked for a ready-to-paste issue title and description capturing the gap and proposed API. Confidence: 0.6

- Prefers planning improvements before implementing multi-file changes: explicitly asked to "plan improvements" for the memory-retrieval upgrade, and the work proceeded through plan mode with a saved plan file that was approved before any code was written. Confidence: 0.6

- Prefers a single shared ranking/selection path for all retrieval surfaces of a memory mod: automatic prompt injection, slash commands, and tool searches must all go through the same helper applying the same relevance threshold, sort, and near-duplicate suppression — no surface may bypass the relevance policy or drift from the others. Confidence: 0.8
- Prefers outcome quality to factor into retrieval ranking: successful episodes should outrank failed ones with overlapping terms (e.g., outcome multiplier: success 1.0, partial 0.85, failed 0.7), applied before feedback and recency so newly stored episodes have a useful quality signal before feedback accumulates. Confidence: 0.8
- Prefers duplicate control at two levels in memory stores: exact normalized duplicates rejected at ingestion time with an observable notice, plus near-duplicate suppression (e.g., ≥80% token overlap) at retrieval time for differently worded but near-identical entries. Confidence: 0.8
- Prefers retrieval to follow the latest user prompt rather than the run's first prompt: injection cache keys, announcements, and re-ranking should all key off the current prompt so stale episodes are not kept injected when a multi-turn run changes tasks. Confidence: 0.8
- Prefers tool-driven memory retrievals to feed the usefulness feedback loop (attributing returned IDs to retrieval counts), while human-only display commands (e.g., `/journal search`) stay out of the model-feedback signal. Confidence: 0.75

- Prefers holistic quality review alongside a targeted fix: when improving retrieval, also asked to "review the mods for any other improvements to quality and relevance" — wants related defects (e.g., broken feedback wiring, validation gaps, stale-data handling, state resets) found and fixed in the same pass, not just the reported issue. Confidence: 0.55
fidence: 0.55

- Prefers checking which files changed recently via the task journal rather than git — asked "what recent files changed, don't use git to check"; when the agent answered with filesystem mtime scanning (`find -mtime` piped through `ls -lt`), the user redirected to "just use journal not git". The task journal is the preferred source of truth for recently changed files; filesystem mtime scans were only a stopgap, not the desired approach. Confidence: 0.7
