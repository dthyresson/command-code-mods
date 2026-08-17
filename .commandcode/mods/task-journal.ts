// ── Task Journal — "What happened before?" ───────────────────────────────
//
// A cross-session episodic memory for Command Code. Session history and
// compaction tell you what THIS session did; Task Journal remembers what
// PAST sessions did — the compressed episodes, not the transcripts.
//
// At the end of a meaningful run it saves a tiny structured episode (task,
// outcome, approaches tried, failures, solution, tests, lesson). "Meaningful"
// means the run changed at least 2 files, or changed 1 file and ran a
// test/check command — read-only exploration (pure read_file/glob/ls) never
// triggers an episode. At the start of the next task it retrieves the top few
// similar episodes and injects them into the system prompt, so a future agent
// can answer "have we solved something resembling this before?" — and find
// the solution in one step instead of re-deriving it.
//
// It deliberately does NOT replace session history or compaction. History
// is the full record; this is the semantic index over it.
//
// ━━━ What this mod demonstrates of the Command Code mod API ━━━━━━━━━━━━━
//
// - `onStop` with `{continue: true}` — a post-run episode extraction pass.
//   When a run that touched the repo would end, the mod injects one extra
//   turn that asks the model to compress what just happened into a JSON
//   episode (task, outcome, approaches, failures, solution, tests, lesson).
//   The same force-continue seam hooku uses for haikus, here put to work
//   building durable episodic memory.
// - `prepareNextTurn` — model switching. The injected extraction turn is
//   routed to a cheap model (deepseek/deepseek-v4-flash by default),
//   keeping the main-loop model on real work.
// - `appendSystemPrompt` — turn-scoped context injection. At the START of
//   a task, prior episodes scored as relevant to the current prompt are
//   injected as "Relevant previous experience" — the retrieval half of the
//   loop. Byte-stable caching keeps the provider prompt-prefix cache warm.
// - `transformInput` — typed-input interception. The mod reads the user's
//   prompt (without changing it) to know what the current task is, and to
//   know when a NEW task has started (so the retrieval block is rebuilt).
// - `afterToolCall` — outcome tracking. The mod sniffs tool results for
//   green/red test-runner output, so retrieval success can be measured
//   without waiting for the run to end.
// - `cmd.addTool` — `task_journal_search`, `task_journal_feedback`, and
//   `task_journal_list`. The model can look up prior experience mid-task
//   or record that the surfaced memories helped.
// - `cmd.addCommand` — `/journal`. Lists episodes, shows a specific one,
//   forgets an episode, or searches the journal.
// - `cmd.ui.notify` / `cmd.ui.setStatus` — 📓 presence. A notify announces
//   each newly stored episode; a persistent footer segment shows the
//   episode count.
// - `cmd.events.emit` — a cross-mod handoff. When an episode reveals a
//   durable repository fact, the journal emits a `task-journal:durable-fact`
//   event on the mod bus. project-brain (which already runs a discovery
//   pass) listens for it, so facts graduate into Project Brain instead of
//   living only in the journal. The two mods cooperate without importing
//   each other.
// - Zero-dependency JSONL storage — append-only, human-inspectable, no
//   external packages.
//
// ━━━ Storage format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
//   One JSON object per line in .commandcode/task-journal.jsonl:
//     {id, task, summary, outcome, filesRead, filesChanged,
//      approaches: [{description, result, reason?}],
//      solution?, tests?: [{command, result}], lesson?,
//      startedAt?, completedAt, gitStart?, gitEnd?,
//      retrievalCount, successfulRetrievalCount}
//
//   Episodes are compressed by design: task + approaches + solution +
//   verification + lesson. Not every command, not every file read, no
//   conversational chatter. Prefer experience over transcript.
//
import type {ModApi} from '@commandcode/harness';
import {appendFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {bold, cyan, dim, green, red, yellow} from './colors';

// ── Limits ──────────────────────────────────────────────────────────────

const MAX_INJECT      = 4;   // episodes injected per task
const MAX_PROPOSE     = 1;   // episodes the extraction pass may propose per run
const MAX_INJECT_TEXT = 4_000; // cap on the injected retrieval block
const MAX_TAIL        = 3_000; // run output sampled for the extraction pass
const STALE_DAYS      = 30;  // episodes older than this are discounted
const RETRIEVAL_SCORE = 1.5; // an episode that helped before ranks higher
const MIN_MEANINGFUL   = 2;   // minimum files changed to auto-extract
const MAX_RETRIEVALS  = 20;  // feedback loop cap (sanity)

// ── Types ───────────────────────────────────────────────────────────────

type Outcome = 'success' | 'partial' | 'failed';

interface Approach {
	readonly description: string;
	readonly result: 'worked' | 'failed' | 'abandoned';
	readonly reason?: string;
}

interface TestRun {
	readonly command: string;
	readonly result: 'passed' | 'failed';
}

interface TaskEpisode {
	readonly id: string;
	readonly task: string;
	readonly summary: string;
	readonly outcome: Outcome;
	readonly filesRead: string[];
	readonly filesChanged: string[];
	readonly approaches: Approach[];
	readonly solution?: string;
	readonly tests?: TestRun[];
	readonly lesson?: string;
	readonly startedAt?: string;
	readonly completedAt: string;
	readonly gitStart?: string;
	readonly gitEnd?: string;

	// Mutable — the feedback loop bumps these in place.
	retrievalCount: number;
	successfulRetrievalCount: number;
}

// ── Small helpers ───────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

function asStr(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}

function genId(): string {
	return 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function normText(s: string): string {
	return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

const STOPWORDS = new Set([
	'the','a','an','is','are','be','to','of','for','in','on','and','or','with',
	'how','what','why','do','does','i','you','me','my','we','our','this','that',
	'it','its','by','at','as','from','can','should','use','using','please','tell',
]);

function tokenize(s: string): string[] {
	return s.toLowerCase()
		.split(/[^a-z0-9_.\/-]+/)
		.filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function isRecent(iso: string, days: number): boolean {
	const age = Date.now() - new Date(iso).getTime();
	return !Number.isNaN(age) && age < days * 24 * 60 * 60 * 1_000;
}

// ── Mod factory ─────────────────────────────────────────────────────────

export default function (cmd: ModApi): void {
	const cwd = cmd.cwd;
	const STORE_PATH = join(cwd, '.commandcode', 'task-journal.jsonl');

	// In-memory store. storeVersion bumps on every write so the injected
	// block is rebuilt when the underlying data changes; injectedCache keeps
	// the block byte-stable across the rounds of one run otherwise.
	let episodes: TaskEpisode[] = [];
	let storeVersion = 0;
	let injectedCache: {key: string; value: string} | null = null;

	// Volatile state lives in the closure (never modState): it must not
	// survive resume, and modState must stay JSON-serializable.
	let initPromise: Promise<void> | null = null;
	let latestUserPrompt = '';                  // current task (transformInput)
	let currentTask = '';                       // first user prompt of the run
	let retrievedEpisodeIds: string[] = [];     // episodes surfaced this run
	let extractionPending = false;              // extraction turn is injected
	let sawSuccessSignal = false;               // a test/check passed this run
	const filesRead = new Set<string>();        // files examined this run
	const filesChanged = new Set<string>();     // files edited this run
	const testRuns: TestRun[] = [];             // test commands + verdicts

	// ── Store helpers ──────────────────────────────────────────────────

	async function loadStore(): Promise<void> {
		episodes = [];
		try {
			const body = await readFile(STORE_PATH, 'utf8');
			for (const line of body.split('\n')) {
				if (!line.trim()) continue;
				try {
					const e = JSON.parse(line) as TaskEpisode;
					if (typeof e?.id === 'string' && typeof e?.task === 'string') {
						episodes.push(e);
					}
				} catch { /* skip a corrupt line */ }
			}
		} catch { /* no store yet */ }
		storeVersion++;
	}

	async function appendEpisode(e: TaskEpisode): Promise<void> {
		await mkdir(dirname(STORE_PATH), {recursive: true});
		await appendFile(STORE_PATH, JSON.stringify(e) + '\n');
		episodes.push(e);
		storeVersion++;
		injectedCache = null;
	}

	// Single-flight lazy init. Never rejects — an unreadable store degrades
	// to "no episodes".
	function ensureInit(): Promise<void> {
		if (!initPromise) {
			initPromise = loadStore().catch(() => {
				initPromise = null; // allow a retry next session
			});
		}
		return initPromise;
	}

	// ── Retrieval ──────────────────────────────────────────────────────

	// Score an episode against the current task: keyword / task-text /
	// path overlap, boosted when the episode proved useful before and
	// discounted when it's old enough that the code may have moved on.
	function scoreEpisode(e: TaskEpisode, promptText: string): number {
		const promptTokens = tokenize(promptText);
		if (!promptTokens.length) return 0;
		const taskText = e.task.toLowerCase() + ' ' + e.summary.toLowerCase();
		let hits = 0;
		for (const t of promptTokens) {
			if (taskText.includes(t) ||
				e.filesChanged.some(f => f.toLowerCase().includes(t)) ||
				e.filesRead.some(f => f.toLowerCase().includes(t))) {
				hits++;
			}
		}
		if (hits === 0) return 0;
		let score = 0.5 + 0.5 * Math.min(1, hits / 3);
		if (e.retrievalCount > 0) {
			score += RETRIEVAL_SCORE *
				(e.successfulRetrievalCount / e.retrievalCount);
		}
		if (e.completedAt && !isRecent(e.completedAt, STALE_DAYS)) {
			score *= 0.5; // old experience — influence, don't override
		}
		return score;
	}

	function renderEpisodeForModel(e: TaskEpisode): string {
		const lines = [
			`### ${e.task}`,
			`Outcome: ${e.outcome}`,
		];
		if (e.approaches?.length) {
			lines.push('', 'What was tried:');
			for (const a of e.approaches) {
				const reason = a.reason ? ` — ${a.reason}` : '';
				lines.push(`- ${a.description} (${a.result})${reason}`);
			}
		}
		if (e.solution) lines.push('', `What worked: ${e.solution}`);
		const files = [...new Set([...(e.filesChanged ?? []), ...(e.filesRead ?? [])])];
		if (files.length) lines.push('', `Relevant files: ${files.join(', ')}`);
		if (e.tests?.length) {
			lines.push('', 'How it was verified:');
			for (const t of e.tests) lines.push(`- \`${t.command}\` ${t.result}`);
		}
		if (e.lesson) lines.push('', `Lesson: ${e.lesson}`);
		lines.push(
			'',
			'Treat this as historical experience, not current truth. Verify it against the present code.',
		);
		return lines.join('\n');
	}

	// Build the system-prompt block for this round. Cached by
	// (storeVersion, current task) so it is byte-stable across the rounds
	// of one run — the provider's prompt-prefix cache keys off those bytes.
	async function buildInjectedBlock(): Promise<string | undefined> {
		await ensureInit();
		const task = currentTask || latestUserPrompt;
		const key = `${storeVersion}:${task}`;
		if (injectedCache?.key === key) return injectedCache.value || undefined;

		let value: string | undefined;
		if (task.trim()) {
			const pick = episodes
				.map(e => ({e, s: scoreEpisode(e, task)}))
				.filter(x => x.s > 0)
				.sort((a, b) => b.s - a.s)
				.slice(0, MAX_INJECT)
				.map(x => x.e);
			if (pick.length) {
				value =
					'[Relevant previous experience — from the task journal]\n\n' +
					pick.map(renderEpisodeForModel).join('\n\n---\n\n') +
					'\n\n(Stored in .commandcode/task-journal.jsonl; historical, not current truth — verify against the present code.)';
				if (value.length > MAX_INJECT_TEXT) {
					value = value.slice(0, MAX_INJECT_TEXT) + '\n…';
				}
			}
		}
		injectedCache = {key, value: value ?? ''};
		return value;
	}

	// ── Episode extraction ─────────────────────────────────────────────

	function extractionEnabled(): boolean {
		return cmd.getFlag('task-journal.extract') !== false;
	}

	function extractionModel(): string {
		const m = cmd.getFlag('task-journal.model');
		return typeof m === 'string' && m ? m : 'deepseek/deepseek-v4-flash';
	}

	// Concrete, data-driven prompt (pipes the actual files/tests/commands
	// the run touched) asking for ONE compressed JSON episode — parsed by
	// ingestExtractionOutput when the turn comes back.
	function extractionPrompt(): string {
		const changed = [...filesChanged];
		const read = [...filesRead].filter(f => !filesChanged.has(f));
		const tests = testRuns.map(t => `  ${t.command} → ${t.result}`).join('\n');
		const scope =
			`Changed: ${changed.join(', ') || '(none)'}\n` +
			`Read: ${read.join(', ') || '(none)'}\n` +
			(tests ? `Tests:\n${tests}\n` : '');
		return (
			'Task Journal extraction pass.\n\n' +
			'Compress the run that just happened into ONE JSON episode object. ' +
			'Focus on what a future agent facing a similar task would need to know:\n\n' +
			'- task: the problem being solved (one line).\n' +
			'- summary: the outcome in one sentence.\n' +
			'- outcome: "success" | "partial" | "failed".\n' +
			'- filesChanged / filesRead: the real paths that mattered, relative to the repo.\n' +
			'- approaches: the materially different approaches attempted, each with\n' +
			'  result "worked" | "failed" | "abandoned" and a one-line reason when there is one.\n' +
			'- solution: what eventually worked (omit if nothing did).\n' +
			'- tests: verification commands with result "passed" | "failed" (omit if none).\n' +
			'- lesson: one sentence that could save a future agent time.\n\n' +
			'Do NOT preserve every command, every file read, temporary hypotheses, or chatter. ' +
			'Prefer experience over transcript.\n\n' +
			`This run:\n${scope}\n\n` +
			'Reply with ONLY one line of JSON — no prose, no markdown fences, no code block. ' +
			'Keep every string field short (task/summary/lesson one sentence each, approaches ≤ 4):\n' +
			'{"task":"...","summary":"...","outcome":"...","filesChanged":["..."],"filesRead":["..."],"approaches":[{"description":"...","result":"..."}],"solution":"...","tests":[{"command":"...","result":"..."}],"lesson":"..."}'
		);
	}

	// Extract a JSON object from the model's reply (fenced block or bare).
	function parseEpisodeJson(text: string): Record<string, unknown> | null {
		if (!text) return null;
		const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		const trimmed = (fenced ? fenced[1] : text).trim();
		const start = trimmed.indexOf('{');
		const end = trimmed.lastIndexOf('}');
		const slice = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
		try {
			const parsed = JSON.parse(slice) as unknown;
			return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
		} catch {
			return null;
		}
	}

	// Turn one model-proposed object into a stored episode (or null if junk).
	async function normalizeEpisode(raw: Record<string, unknown>): Promise<TaskEpisode | null> {
		const task = asStr(raw.task)?.trim() ?? '';
		const summary = asStr(raw.summary)?.trim() ?? '';
		if (!task || task.length < 8) return null; // too vague to be durable
		if (!summary) return null;

		const outcome = (asStr(raw.outcome) ?? '').toLowerCase();
		if (outcome !== 'success' && outcome !== 'partial' && outcome !== 'failed') {
			return null;
		}

		const strArr = (v: unknown): string[] =>
			(Array.isArray(v) ? v : [])
				.filter((s): s is string => typeof s === 'string')
				.map(s => s.trim().replace(/^\.\//, ''))
				.filter(Boolean);
		const filesChanged = [...new Set(strArr(raw.filesChanged))];
		const filesRead = [...new Set(strArr(raw.filesRead))];

		const approaches: Approach[] = (Array.isArray(raw.approaches) ? raw.approaches : [])
			.filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
			.map(a => ({
				description: asStr(a.description)?.trim() ?? '',
				result: (asStr(a.result) ?? '') === 'failed'
					? 'failed' as const
					: (asStr(a.result) ?? '') === 'abandoned'
						? 'abandoned' as const
						: 'worked' as const,
				reason: asStr(a.reason)?.trim() || undefined,
			}))
			.filter(a => a.description.length > 0)
			.slice(0, 8);

		const tests: TestRun[] | undefined =
			Array.isArray(raw.tests)
				? (raw.tests as Record<string, unknown>[])
					.filter(t => !!t && typeof t === 'object')
					.map(t => ({
						command: asStr(t.command)?.trim() ?? '',
						result: (asStr(t.result) ?? '') === 'failed' ? 'failed' as const : 'passed' as const,
					}))
					.filter(t => t.command.length > 0)
					.slice(0, 8)
				: undefined;

		const solution = asStr(raw.solution)?.trim() || undefined;
		const lesson = asStr(raw.lesson)?.trim() || undefined;

		return {
			id: genId(),
			task,
			summary,
			outcome,
			filesRead,
			filesChanged,
			approaches,
			solution,
			tests: tests?.length ? tests : undefined,
			lesson,
			completedAt: new Date().toISOString(),
			retrievalCount: 0,
			successfulRetrievalCount: 0,
		};
	}

	async function ingestExtractionOutput(text: string): Promise<boolean> {
		const raw = parseEpisodeJson(text);
		if (!raw) {
			console.error(
				`[task-journal] extraction output unparseable — no episode written. ` +
				`Reply was ${text?.length ?? 0} chars.`
			);
			cmd.ui.notify(`${red('✖')} ${dim('journal')} ${bold('Extraction output unparseable')} — episode dropped.`);
			return false;
		}
		const episode = await normalizeEpisode(raw);
		if (!episode) {
			console.error(
				`[task-journal] extraction output failed validation — no episode written. ` +
				`task=${JSON.stringify(raw.task)} outcome=${JSON.stringify(raw.outcome)}.`
			);
			cmd.ui.notify(`${yellow('⚠')} ${dim('journal')} ${bold('Extraction output invalid')} — episode dropped.`);
			return false;
		}
		try {
			await appendEpisode(episode);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[task-journal] write to task-journal.jsonl failed: ${msg}`);
			cmd.ui.notify(`${red('✖')} ${dim('journal')} ${bold('Write failed')}: ${truncate(msg, 60)}`);
			return false;
		}
		cmd.ui.notify(`${green('✔')} ${dim('journal')} ${bold(cyan('Journaled'))}: ${truncate(episode.task, 100)}`);
		updateStatus();
		// If the episode reveals a durable repo fact, hand it to
		// project-brain (if loaded) — facts graduate out of the journal.
		if (episode.lesson) {
			cmd.events.emit('task-journal:durable-fact', {
				fact: episode.lesson,
				sourceFiles: episode.filesChanged.length
					? episode.filesChanged
					: episode.filesRead,
				confidence: episode.outcome === 'success' ? 0.8 : 0.5,
			});
		}
		return true;
	}

	// ── Feedback loop ──────────────────────────────────────────────────

	// After a tool call, feed the retrieved-episode success signal: the
	// run's own tool results (green test output, file writes) are the
	// cheapest honest proxy for "did this task succeed".
	async function recordToolOutcome(toolName: string, result: unknown): Promise<void> {
		if (!retrievedEpisodeIds.length || sawSuccessSignal) return;
		const text = typeof result === 'string' ? result : '';
		if (/(?:tests?|checks?)\s+(?:passed|succeeded)|all green|ok\s*\(?\d+\s*(?:passed|tests?)/i.test(text)) {
			sawSuccessSignal = true;
			await recordRetrievalOutcome(true);
		}
	}

	async function recordRetrievalOutcome(successful: boolean): Promise<void> {
		if (!retrievedEpisodeIds.length) return;
		const ids = new Set(retrievedEpisodeIds.slice(0, MAX_RETRIEVALS));
		let dirty = false;
		for (const e of episodes) {
			if (!ids.has(e.id)) continue;
			e.retrievalCount++;
			if (successful) e.successfulRetrievalCount++;
			dirty = true;
		}
		if (!dirty) return;
		storeVersion++;
		injectedCache = null;
		await mkdir(dirname(STORE_PATH), {recursive: true});
		const body = episodes.map(e => JSON.stringify(e)).join('\n') +
			(episodes.length ? '\n' : '');
		await writeStore(body);
	}

	// Rewrite the whole store (used by feedback + forget; appends go
	// through appendEpisode for cheapness).
	async function writeStore(body: string): Promise<void> {
		await writeFile(STORE_PATH, body);
	}

	// ── UI ─────────────────────────────────────────────────────────────

	function updateStatus(): void {
		const n = episodes.length;
		cmd.ui.setStatus(`${cyan('📓')} ${n} episode${n === 1 ? '' : 's'}`);
	}

	function listEpisodesMessage(): string {
		if (!episodes.length) {
			return '📓 No episodes yet — run a task that changes files and one will be journaled automatically.';
		}
		const rows = [...episodes].reverse().map(e => {
			const badge = e.outcome === 'success' ? '✅' : e.outcome === 'partial' ? '🟡' : '❌';
			const files = e.filesChanged.length ? ` · ${e.filesChanged.join(', ')}` : '';
			const used = e.retrievalCount
				? ` · retrieved ${e.retrievalCount}× (${e.successfulRetrievalCount} helped)`
				: '';
			return `${badge} ${e.task}\n` +
				`   ─ ${e.summary}\n` +
				`   📎 ${e.completedAt.slice(0, 10)} · ${e.id}${files}${used}`;
		});
		return `📓 Task Journal — ${episodes.length} episode(s)\n\n${rows.join('\n\n')}`;
	}

	function renderEpisodeDetail(e: TaskEpisode): string {
		const lines = [
			`📓 ${e.task}`,
			`Outcome: ${e.outcome}`,
			`Completed: ${e.completedAt}`,
			`ID: ${e.id}`,
		];
		if (e.filesChanged.length) lines.push(`Changed: ${e.filesChanged.join(', ')}`);
		if (e.filesRead.length) lines.push(`Read: ${e.filesRead.join(', ')}`);
		if (e.approaches.length) {
			lines.push('', 'Approaches:');
			for (const a of e.approaches) {
				lines.push(`- ${a.description} (${a.result}${a.reason ? `: ${a.reason}` : ''})`);
			}
		}
		if (e.solution) lines.push('', `Solution: ${e.solution}`);
		if (e.tests?.length) {
			lines.push('', 'Tests:');
			for (const t of e.tests) lines.push(`- \`${t.command}\` ${t.result}`);
		}
		if (e.lesson) lines.push('', `Lesson: ${e.lesson}`);
		lines.push('', `Retrieved ${e.retrievalCount}× (${e.successfulRetrievalCount} helped)`);
		return lines.join('\n');
	}

	// ── Configuration ──────────────────────────────────────────────────

	cmd.addFlag('task-journal.extract', {
		type: 'boolean',
		default: true,
		description: 'Run an episode extraction pass after runs that changed files.',
	});
	cmd.addFlag('task-journal.model', {
		type: 'string',
		default: 'deepseek/deepseek-v4-flash',
		description: 'Cheap model used for the extraction pass.',
	});

	// ── Hooks ──────────────────────────────────────────────────────────

	cmd.hooks({

		/**
		 * onSessionStart — load the journal and render the footer count.
		 */
		onSessionStart: async () => {
			initPromise = null;      // force a fresh load
			await ensureInit();
			updateStatus();
		},

		/**
		 * onSessionEnd — clear the footer so no stale count leaks into the
		 * next session.
		 */
		onSessionEnd: () => {
			cmd.ui.setStatus(' ');
		},

		/**
		 * transformInput — the mods' typed-input seam. The journal only
		 * reads: the first prompt of a run becomes the current task (and
		 * later prompts of the same run don't reset the retrieval block).
		 */
		transformInput: ({text}) => {
			if (!currentTask) currentTask = text;
			latestUserPrompt = text;
			return undefined; // pass the prompt through unchanged
		},

		/**
		 * appendSystemPrompt — the retrieval seam. Fires once per round
		 * with the resolved base prompt; the returned block is appended
		 * after it. Prior episodes scored as relevant to the current task
		 * are injected here. Cached by storeVersion + task so the block
		 * stays byte-stable across the rounds of one run.
		 */
		appendSystemPrompt: async () => buildInjectedBlock(),

		/**
		 * afterToolCall — activity + outcome tracking. Records which files
		 * the run read or edited (for the extraction prompt), which test
		 * commands ran and their verdict, and feeds the retrieved-episode
		 * success signal from the run's own green test output.
		 */
		afterToolCall: async ({toolName, input, result}) => {
			const inp = input as Record<string, unknown> | undefined;
			const fp = asStr(inp?.file_path);
			if (fp) {
				if (toolName === 'write_file' || toolName === 'edit_file') {
					filesChanged.add(fp);
				} else {
					filesRead.add(fp);
				}
			}
			if (toolName === 'glob') {
				const pattern = asStr(inp?.pattern);
				if (pattern) filesRead.add(pattern);
			}
			if (toolName === 'shell_command') {
				const command = asStr(inp?.command) ?? '';
				if (/(?:test|check|lint|build|typecheck|tsc)\b/.test(command)) {
					const verdict = /(?:fail|error|✗)/i.test(command) ? 'failed' : 'passed';
					testRuns.push({command: truncate(command, 120), result: verdict});
				}
			}
			if (toolName === 'task_journal_feedback') {
				const r = input as Record<string, unknown> | undefined;
				if (r?.successful === true) {
					sawSuccessSignal = true;
					await recordRetrievalOutcome(true);
				}
			}
			await recordToolOutcome(toolName, result);
			return undefined;
		},

		/**
		 * prepareNextTurn — model switching. Only when an extraction turn
		 * is pending does the journal route the next model call to the
		 * cheap model; every other turn runs on the session model.
		 */
		prepareNextTurn: () => {
			if (!extractionPending) return undefined;
			return {model: extractionModel()};
		},

		/**
		 * onStop — the force-continue seam that makes extraction possible.
		 * Phase 1: a run that changed files (or an explicit /journal write)
		 * would end → inject one extraction turn. Phase 2: the extraction
		 * turn finished → parse its JSON, store the episode, notify 📓,
		 * and record whether the previously retrieved memories helped.
		 *
		 * A run is "meaningful" only if it changed ≥2 files, or changed ≥1
		 * file AND ran a test/check command (see MIN_MEANINGFUL). Read-only
		 * runs — pure reads, globs, inspect commands — are not worth an
		 * episode and skip extraction (the feedback loop still closes out).
		 */
		onStop: async ({lastAssistantText}) => {
			if (extractionPending) {
				// Phase 2: the extraction turn finished. Ingest its reply;
				// if it wasn't our episode (a sibling mod's continuation
				// payload can land here), keep pending so the next stop
				// retries with the correct text instead of dropping.
				let ok = false;
				try {
					ok = await ingestExtractionOutput(lastAssistantText);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.error(`[task-journal] extraction ingest threw: ${msg}`);
					cmd.ui.notify(`${red('✖')} ${dim('journal')} ${bold('Extraction failed')}: ${truncate(msg, 60)}`);
				}
				if (!ok) {
					cmd.ui.notify(`${dim('journal')} ${bold(cyan('Retrying extraction'))}...`);
					return {continue: true, reason: extractionPrompt()};
				}
				extractionPending = false;
				return {continue: false};
			}
			const meaningful = filesChanged.size >= MIN_MEANINGFUL ||
				(filesChanged.size > 0 && testRuns.length > 0);
			if (!extractionEnabled() || !meaningful) {
				// Still close out the retrieval feedback loop.
				await recordRetrievalOutcome(sawSuccessSignal);
				return {continue: false};
			}
			extractionPending = true;
			cmd.ui.notify(`${dim('journal')} ${bold(cyan('Extracting episode'))} with ${extractionModel()}...`);
			return {continue: true, reason: extractionPrompt()};
		},

		/**
		 * onRunEnd — the feedback + cleanup boundary. Runs after the loop
		 * exits (including hard stops like max_turns, where onStop never
		 * fires), so the retrieval outcome is always recorded; then this
		 * run's activity is dropped so the next run starts clean.
		 */
		onRunEnd: async () => {
			await recordRetrievalOutcome(sawSuccessSignal);
			currentTask = '';
			retrievedEpisodeIds = [];
			filesRead.clear();
			filesChanged.clear();
			testRuns.length = 0;
			sawSuccessSignal = false;
		},
	});

	// ── Slash command: /journal ────────────────────────────────────────

	cmd.addCommand({
		name: 'journal',
		description: 'Task Journal: list episodes, show one, forget one, or search.',
		argumentHint: '[list | show <id> | search <query> | forget <id>]',
		handler: async ({args}) => {
			await ensureInit();
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase();

			switch (sub) {
				case 'show': {
					const id = parts[1];
					const e = episodes.find(x => x.id === id);
					return {
						message: e ? renderEpisodeDetail(e) : `📓 No episode with id "${id}". Run /journal to list them.`,
					};
				}
				case 'forget': {
					const id = parts[1];
					const idx = episodes.findIndex(x => x.id === id);
					if (idx < 0) {
						return {
							message: `📓 No episode with id "${id}". Run /journal to list them.`,
						};
					}
					const [removed] = episodes.splice(idx, 1);
					storeVersion++;
					injectedCache = null;
					await mkdir(dirname(STORE_PATH), {recursive: true});
					await writeStore(
						episodes.map(e => JSON.stringify(e)).join('\n') +
						(episodes.length ? '\n' : ''),
					);
					updateStatus();
					return {message: `📓 Forgotten: ${removed.task}`};
				}
				case 'search': {
					const query = parts.slice(1).join(' ');
					if (!query) {
						return {message: '📓 Usage: /journal search <query>'};
					}
					const ranked = episodes
						.map(e => ({e, s: scoreEpisode(e, query)}))
						.filter(x => x.s > 0)
						.sort((a, b) => b.s - a.s)
						.slice(0, MAX_INJECT)
						.map(x => x.e);
					if (!ranked.length) {
						return {message: `📓 No episodes match "${query}".`};
					}
					return {
						message: `📓 Episodes matching "${query}":\n\n` +
							ranked.map(e => {
								const badge = e.outcome === 'success' ? '✅' : e.outcome === 'partial' ? '🟡' : '❌';
								return `${badge} ${e.task}\n   ─ ${e.summary} · ${e.id}`;
							}).join('\n\n'),
					};
				}
				default:
					return {message: listEpisodesMessage()};
			}
		},
	});

	// ── Tools ──────────────────────────────────────────────────────────

	cmd.addTool({
		schema: {
			name: 'task_journal_search',
			description:
				'Search the task journal for prior episodes similar to a task description. ' +
				'Returns compressed episodes (approaches tried, failures, solution, tests, lesson) ' +
				'from past sessions — useful when a current task resembles something solved before. ' +
				'Historical experience, not current truth: verify against the present code.',
			input_schema: {
				type: 'object',
				properties: {
					query: {type: 'string', description: 'Task description to match against prior episodes.'},
					limit: {type: 'number', description: 'Max episodes to return (default 4).'},
				},
				required: ['query'],
			},
		},
		readOnly: true,
		run: async ({input}) => {
			await ensureInit();
			const q = asStr((input as Record<string, unknown>)?.query) ?? '';
			const limit = clamp(Number((input as Record<string, unknown>)?.limit) || MAX_INJECT, 1, 10);
			if (!q.trim()) {
				return {ok: false, error: 'A query string is required.'};
			}
			const ranked = episodes
				.map(e => ({e, s: scoreEpisode(e, q)}))
				.filter(x => x.s > 0)
				.sort((a, b) => b.s - a.s)
				.slice(0, limit)
				.map(x => x.e);
			if (!ranked.length) {
				return {ok: true, content: [{type: 'text', text: 'No matching episodes in the task journal.'}]};
			}
			return {
				ok: true,
				content: [{
					type: 'text',
					text: ranked.map(renderEpisodeForModel).join('\n\n---\n\n'),
				}],
			};
		},
	});

	cmd.addTool({
		schema: {
			name: 'task_journal_feedback',
			description:
				'Record whether episodes surfaced by the task journal helped the current task. ' +
				'Call with successful=true after a task that used retrieved journal context finishes ' +
				'successfully (tests pass, fix verified). This trains the journal\u2019s retrieval signal.',
			input_schema: {
				type: 'object',
				properties: {
					successful: {
						type: 'boolean',
						description: 'Whether the retrieved journal context contributed to a successful outcome.',
					},
					note: {type: 'string', description: 'Optional note about how the context helped.'},
				},
				required: ['successful'],
			},
		},
		run: async ({input}) => {
			await ensureInit();
			const successful = (input as Record<string, unknown>)?.successful === true;
			await recordRetrievalOutcome(successful);
			return {
				ok: true,
				content: [{
					type: 'text',
					text: successful
						? 'Recorded: retrieved journal episodes helped this task. Future similar tasks rank higher.'
						: 'Recorded: retrieved journal episodes did not help this task.',
				}],
			};
		},
	});

	cmd.addTool({
		schema: {
			name: 'task_journal_list',
			description:
				'List episodes stored in the task journal (task, outcome, date, id). ' +
				'Read-only; use task_journal_search to find relevant ones.',
			input_schema: {type: 'object', properties: {}, required: []},
		},
		readOnly: true,
		run: async () => {
			await ensureInit();
			return {
				ok: true,
				content: [{type: 'text', text: listEpisodesMessage()}],
			};
		},
	});

	// Kick the load off immediately so /journal and the first injection
	// don't race the file read.
	void ensureInit();
}
