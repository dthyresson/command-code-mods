// ── Task Journal — "What happened before?" ───────────────────────────────
//
// A cross-session episodic memory for Command Code. Session history and
// compaction tell you what THIS session did; Task Journal remembers what
// PAST sessions did — the compressed episodes, not the transcripts.
//
// At the end of a meaningful run it saves a tiny structured episode (task,
// outcome, approaches tried, decisions made, failures, solution, tests,
// lesson). "Meaningful" means the run changed at least 2 files, or changed 1
// file and ran a test/check command — read-only exploration (pure
// read_file/glob/ls) never triggers an episode. At the start of the next task
// it retrieves the top few
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
//   episode (task, outcome, approaches, decisions, failures, solution, tests,
//   lesson). The same force-continue seam hooku uses for haikus, here put to
//   work building durable episodic memory.
// - `prepareNextTurn` — model switching. The injected extraction turn is
//   routed to a cheap model (deepseek/deepseek-v4-flash by default),
//   keeping the main-loop model on real work.
// - `appendSystemPrompt` — turn-scoped context injection. At the START of
//   a task, prior episodes scored as relevant to the current prompt are
//   injected as "Relevant previous experience" — the retrieval half of the
//   loop. Byte-stable caching keeps the provider prompt-prefix cache warm.
// - `transformInput` — typed-input interception. The mod reads the user's
//   prompt (without changing it) so retrieval follows the task being solved.
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
//      decisions: [{choice, reason?, rejected?}],
//      solution?, tests?: [{command, result}], lesson?,
//      startedAt?, completedAt, gitStart?, gitEnd?,
//      retrievalCount, successfulRetrievalCount}
//
//   Episodes are compressed by design: task + approaches + decisions +
//   solution + verification + lesson. Not every command, not every file read,
//   no conversational chatter. Prefer experience over transcript.
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
const MIN_MEANINGFUL   = 2;   // minimum files changed to auto-extract
const MAX_RETRIEVALS  = 20;  // feedback loop cap (sanity)
const RELATIVE_DAYS   = 3;   // list dates show "x ago" within this window, else full date

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

interface Decision {
	readonly choice: string;
	readonly reason?: string;
	readonly rejected?: string;
}

interface TaskEpisode {
	readonly id: string;
	readonly task: string;
	readonly summary: string;
	readonly outcome: Outcome;
	readonly filesRead: string[];
	readonly filesChanged: string[];
	readonly approaches: Approach[];
	readonly decisions: Decision[];
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
	let currentTask = '';                       // retained for extraction context
	let retrievedEpisodeIds: string[] = [];     // episodes surfaced this run
	let extractionPending = false;              // extraction turn is injected
	let sawSuccessSignal = false;               // a test/check passed this run
	let injectedEpisodes: TaskEpisode[] = [];   // episodes announced via notify/showEntry
	let announcedPromptKey: string | null = null; // only announce once per task
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

	const EPISODE_MIN_SCORE = 2.5;
	const EPISODE_FIELD_WEIGHTS = {
		task: 4, summary: 3, solution: 4, lesson: 4, changedPath: 3,
		readPath: 2, decision: 2, approach: 1, test: 1,
	};
	const PHRASE_BONUS = 1.5;
	const FEEDBACK_MIN_RETRIEVALS = 3;
	const FEEDBACK_MAX = 0.25;

	function uniqueTokens(s: string): string[] {
		return [...new Set(tokenize(s))];
	}

	function tokenSet(s: string): Set<string> {
		return new Set(tokenize(s));
	}

	function pathTokens(paths: string[]): Set<string> {
		return new Set(paths.flatMap(path => {
			const parts = path.split(/[\\/]/g);
			return parts.flatMap(part => [part, ...part.split(/[._-]+/g)]).flatMap(tokenize);
		}));
	}

	function episodeFields(e: TaskEpisode): Record<string, string> {
		return {
			task: e.task,
			summary: e.summary,
			solution: e.solution ?? '',
			lesson: e.lesson ?? '',
			changedPath: e.filesChanged.join(' '),
			readPath: e.filesRead.join(' '),
			decision: (e.decisions ?? []).map(d => `${d.choice} ${d.reason ?? ''} ${d.rejected ?? ''}`).join(' '),
			approach: (e.approaches ?? []).map(a => `${a.description} ${a.reason ?? ''}`).join(' '),
			test: (e.tests ?? []).map(t => t.command).join(' '),
		};
	}

	function documentFrequency(items: TaskEpisode[]): Map<string, number> {
		const frequencies = new Map<string, number>();
		for (const e of items) {
			const fields = episodeFields(e);
			const tokens = new Set(Object.values(fields).flatMap(tokenize));
			for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
		}
		return frequencies;
	}

	function rarity(token: string, total: number, frequencies: Map<string, number>): number {
		return Math.log((total + 1) / ((frequencies.get(token) ?? 0) + 1)) + 1;
	}

	function phraseCount(query: string, fields: string[]): number {
		const tokens = uniqueTokens(query);
		const phrases = tokens.slice(0, -1).map((token, i) => `${token} ${tokens[i + 1]}`);
		const normalizedFields = fields.map(normText);
		return phrases.filter(phrase => normalizedFields.some(field => field.includes(phrase))).length;
	}

	function recencyMultiplier(iso: string): number {
		const ageMs = Date.now() - new Date(iso).getTime();
		if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
		const ageDays = ageMs / (24 * 60 * 60 * 1_000);
		return 0.5 + 0.5 / (1 + ageDays / STALE_DAYS);
	}

	function outcomeMultiplier(outcome: Outcome): number {
		return outcome === 'success' ? 1 : outcome === 'partial' ? 0.85 : 0.7;
	}

	function scoreEpisode(e: TaskEpisode, promptText: string): number {
		const queryTokens = uniqueTokens(promptText);
		if (!queryTokens.length) return 0;
		const fields = episodeFields(e);
		const frequencies = documentFrequency(episodes);
		let score = 0;
		let signals = 0;
		for (const token of queryTokens) {
			const weight = rarity(token, episodes.length, frequencies);
			for (const [field, text] of Object.entries(fields)) {
				if (tokenSet(text).has(token)) {
					score += EPISODE_FIELD_WEIGHTS[field as keyof typeof EPISODE_FIELD_WEIGHTS] * weight;
					signals++;
				}
			}
		}
		const pathMatch = [...pathTokens([...e.filesChanged, ...e.filesRead])]
			.some(token => queryTokens.includes(token));
		const phrases = phraseCount(promptText, Object.values(fields));
		if (phrases) score += phrases * PHRASE_BONUS;
		if (!signals || (score < EPISODE_MIN_SCORE && !pathMatch && !phrases)) return 0;
		score *= outcomeMultiplier(e.outcome);
		if (e.retrievalCount >= FEEDBACK_MIN_RETRIEVALS) {
			const successRate = clamp(e.successfulRetrievalCount / e.retrievalCount, 0, 1);
			score *= 1 + FEEDBACK_MAX * successRate;
		}
		return score * recencyMultiplier(e.completedAt);
	}

	function rankEpisodes(promptText: string, limit = MAX_INJECT): TaskEpisode[] {
		const ranked = episodes
			.map(e => ({e, s: scoreEpisode(e, promptText)}))
			.filter(x => x.s > 0)
			.sort((a, b) => b.s - a.s || b.e.completedAt.localeCompare(a.e.completedAt));
		const selected: Array<{e: TaskEpisode; s: number}> = [];
		for (const candidate of ranked) {
			const candidateTokens = new Set(Object.values(episodeFields(candidate.e)).flatMap(tokenize));
			const duplicate = selected.some(item => {
				const existingTokens = new Set(Object.values(episodeFields(item.e)).flatMap(tokenize));
				const shared = [...candidateTokens].filter(token => existingTokens.has(token)).length;
				return shared / Math.max(1, Math.max(candidateTokens.size, existingTokens.size)) >= 0.8;
			});
			if (!duplicate) selected.push(candidate);
			if (selected.length >= limit) break;
		}
		return selected.map(item => item.e);
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
		if (e.decisions?.length) {
			lines.push('', 'Key decisions:');
			for (const d of e.decisions) {
				const reason = d.reason ? ` — ${d.reason}` : '';
				const rejected = d.rejected ? ` (rejected: ${d.rejected})` : '';
				lines.push(`- ${d.choice}${reason}${rejected}`);
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
	// (storeVersion, latest prompt) so it is byte-stable across the rounds
	// of one run — the provider's prompt-prefix cache keys off those bytes.
	async function buildInjectedBlock(): Promise<string | undefined> {
		await ensureInit();
		const task = latestUserPrompt;
		const key = `${storeVersion}:${task}`;
		if (injectedCache?.key === key) return injectedCache.value || undefined;

		let value: string | undefined;
		if (task.trim()) {
			const pick = rankEpisodes(task);
			injectedEpisodes = pick;
			retrievedEpisodeIds = pick.map(e => e.id);
			if (pick.length) {
				value =
					'[Relevant previous experience — from the task journal]\n\n' +
					pick.map(renderEpisodeForModel).join('\n\n---\n\n') +
					'\n\n(Stored in .commandcode/task-journal.jsonl; historical, not current truth — verify against the present code.)';
				if (value.length > MAX_INJECT_TEXT) {
					value = value.slice(0, MAX_INJECT_TEXT) + '\n…';
				}
			}
		} else {
			injectedEpisodes = [];
		}
		injectedCache = {key, value: value ?? ''};
		return value;
	}

	// ── Injection announcement ────────────────────────────────────────

	// Key identifying the current prompt (the same key that keeps the retrieval
	// block stable). New prompt text (or run end) re-arms the announce; a given
	// prompt only announces once even though appendSystemPrompt fires per round.
	function promptKey(): string {
		return latestUserPrompt;
	}

	// Notify that episodes were injected, and show the exact list in the
	// feed so the user sees precisely what experience is being used.
	function announceInjection(key: string): void {
		if (announcedPromptKey === key) return;
		announcedPromptKey = key;
		if (!injectedEpisodes.length) return;
		const n = injectedEpisodes.length;
		const lines = injectedEpisodes.map((e, i) =>
			`${i + 1}. ${e.task}\n` +
			`   Outcome: ${e.outcome}` +
			(e.summary ? ` — ${e.summary}` : '') +
			(e.lesson ? `\n   Lesson: ${e.lesson}` : '') +
			(e.decisions?.length
				? `\n   Decisions: ${e.decisions.map(d => d.choice).join('; ')}`
				: '') +
			`\n   ${e.id}`);
		cmd.ui.notify(`${dim('journal')} ${bold(cyan(`${n} relevant episode${n === 1 ? '' : 's'} injected`))} — see feed entry for details.`);
		cmd.showEntry('task-journal-injected', {title: 'Task Journal — relevant experience injected', lines});
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
			'- decisions: the key choices made this run — each with the choice, why it\n' +
			'  was made, and the alternative that was rejected (omit if none were notable).\n' +
			'- solution: what eventually worked (omit if nothing did).\n' +
			'- tests: verification commands with result "passed" | "failed" (omit if none).\n' +
			'- lesson: one sentence that could save a future agent time.\n\n' +
			'Do NOT preserve every command, every file read, temporary hypotheses, or chatter. ' +
			'Prefer experience over transcript.\n\n' +
			`This run:\n${scope}\n\n` +
			'Reply with ONLY one line of JSON — no prose, no markdown fences, no code block. ' +
			'Keep every string field short (task/summary/lesson one sentence each, approaches ≤ 4, decisions ≤ 4):\n' +
			'{"task":"...","summary":"...","outcome":"...","filesChanged":["..."],"filesRead":["..."],"approaches":[{"description":"...","result":"..."}],"decisions":[{"choice":"...","reason":"...","rejected":"..."}],"solution":"...","tests":[{"command":"...","result":"..."}],"lesson":"..."}'
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

		const decisions: Decision[] = (Array.isArray(raw.decisions) ? raw.decisions : [])
			.filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
			.map(d => ({
				choice: asStr(d.choice)?.trim() ?? '',
				reason: asStr(d.reason)?.trim() || undefined,
				rejected: asStr(d.rejected)?.trim() || undefined,
			}))
			.filter(d => d.choice.length > 0)
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
			decisions,
			solution,
			tests: tests?.length ? tests : undefined,
			lesson,
			completedAt: new Date().toISOString(),
			retrievalCount: 0,
			successfulRetrievalCount: 0,
		};
	}

	function isDuplicateEpisode(candidate: TaskEpisode): boolean {
		const key = `${normText(candidate.task)}\n${normText(candidate.summary)}`;
		return episodes.some(e => `${normText(e.task)}\n${normText(e.summary)}` === key);
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
		if (isDuplicateEpisode(episode)) {
			console.error(`[task-journal] duplicate episode skipped: ${episode.task}`);
			cmd.ui.notify(`${yellow('⚠')} ${dim('journal')} ${bold('Duplicate episode skipped')}: ${truncate(episode.task, 80)}`);
			return true;
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
		// If the episode reveals a durable repo fact (a lesson or a key
		// decision), hand it to project-brain (if loaded) — facts graduate
		// out of the journal.
		if (episode.lesson || episode.decisions.length) {
			cmd.events.emit('task-journal:durable-fact', {
				fact: episode.lesson
					?? `Decision: ${episode.decisions[0].choice}` +
						(episode.decisions[0].reason ? ` — ${episode.decisions[0].reason}` : ''),
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

	// Relative date for list rows: "x mins ago" / "x hr ago" / "x days ago"
	// within RELATIVE_DAYS, otherwise the full YYYY-MM-DD date.
	function formatDate(iso: string): string {
		const then = new Date(iso).getTime();
		if (Number.isNaN(then)) return iso.slice(0, 10);
		const mins = Math.round((Date.now() - then) / 60_000);
		if (mins < 60) return `${Math.max(1, mins)} mins ago`;
		const hrs = Math.round(mins / 60);
		if (hrs < 24 * RELATIVE_DAYS) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
		const days = Math.round(hrs / 24);
		return `${days} days ago`;
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
				`   📎 ${formatDate(e.completedAt)} · ${e.id}${files}${used}`;
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
		if (e.decisions?.length) {
			lines.push('', 'Decisions:');
			for (const d of e.decisions) {
				const reason = d.reason ? `: ${d.reason}` : '';
				const rejected = d.rejected ? ` (rejected: ${d.rejected})` : '';
				lines.push(`- ${d.choice}${reason}${rejected}`);
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
			announcedPromptKey = null;
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
		 * transformInput — the mods' typed-input seam. The journal reads
		 * the latest prompt so retrieval follows the task currently being solved.
		 */
		transformInput: ({text}) => {
			if (!currentTask) currentTask = text;
			latestUserPrompt = text;
			return undefined; // pass the prompt through unchanged
		},

		/**
		 * appendSystemPrompt — the retrieval seam. Fires once per round
		 * with the resolved base prompt; the returned block is appended
		 * after it. Prior episodes scored as relevant to the latest prompt
		 * are injected here. Cached by storeVersion + prompt so the block
		 * stays byte-stable across the rounds of one run.
		 */
		appendSystemPrompt: async () => {
			const block = await buildInjectedBlock();
			if (block) announceInjection(promptKey());
			return block;
		},

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
			announcedPromptKey = null;
			injectedEpisodes = [];
		},
	});

	// ── Slash command: /journal ────────────────────────────────────────

	// Renderer for the injection-announcement feed entry. First registration
	// per type wins, so this stays ours.
	cmd.addRenderer('task-journal-injected', data => {
		const d = data as {title?: string; lines?: string[]};
		const lines = [...(d.lines ?? [])];
		if (d.title) lines.unshift(dim(cyan(d.title)));
		return lines;
	});

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
					const ranked = rankEpisodes(query);
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
				'Returns compressed episodes (approaches tried, decisions made, failures, ' +
				'solution, tests, lesson) from past sessions — useful when a current task ' +
				'resembles something solved before. ' +
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
			const ranked = rankEpisodes(q, limit);
			for (const e of ranked) {
				if (!retrievedEpisodeIds.includes(e.id)) retrievedEpisodeIds.push(e.id);
			}
			retrievedEpisodeIds = retrievedEpisodeIds.slice(-MAX_RETRIEVALS);
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
