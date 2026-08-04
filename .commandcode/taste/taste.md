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

- Prefers thorough discovery before creating or changing configuration: glob for existing files, consult knowledge base topics, read directories, check current config values, shell-command to inspect, web-search and web-fetch for docs — exhaust available information before writing anything. Confidence: 0.7

- Prefers explicit intent in configuration files, even at the cost of some redundancy. When a permission or setting is technically covered by another rule (e.g., `Edit` already covers `Write`), it's still worth including the redundant rule if it makes the intended behavior more obvious to a reader. Confidence: 0.5

- Prefers namespaced flag names for Command Code mods — every flag should use a `modname.` prefix (e.g., `weather.city`, `clock.tz1`) to prevent collisions between mods. Bare flag names like `city` without a namespace prefix are a convention violation even if they happen to work. Confidence: 0.8

- Prefers widget/UI element registration to happen inside lifecycle hooks (especially `onSessionStart`) rather than at module-import time. Creating widgets at module load causes them to appear before a session exists; deferring to `onSessionStart` ensures proper lifecycle alignment. Confidence: 0.7

- Prefers a single `cmd.hooks()` call per mod that registers all hooks together, rather than spreading hook registrations across multiple invocations. Confidence: 0.5
