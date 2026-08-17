// ── Project Brain — "What is true about this codebase?" ─────────────────
//
// A durable project memory that complements AGENTS.md. AGENTS.md is hand-
// written and static; Project Brain is learned. It watches what the agent
// actually does, runs a short "discovery pass" when a run ends, and stores
// durable facts — auth middleware lives in packages/auth, FooClient is
// deprecated, migrations must regenerate the schema — as JSON lines in
// .commandcode/project-brain.jsonl (tracked in git, created on first write).
//
// On every turn it injects ONLY the facts relevant to the current prompt
// into the system prompt (appendSystemPrompt), so the model starts each task
// already knowing what is true about the repo. Unrelated facts stay out.
//
// And because code is the source of truth, every fact records the files it
// came from: each supporting file is content-hashed (sha256), and a fact
// whose code changed is invalidated (flipped to `stale`) instead of blindly
// trusted. On every session start each active fact's files are re-hashed; a
// changed or deleted file retires the fact from the system prompt.
//
// ━━━ What this mod demonstrates of the Command Code mod API ━━━━━━━━━━━━━
//
// - `appendSystemPrompt` — turn-scoped context injection. The heart of the
//   mod: every round, facts scored as relevant to the current prompt are
//   appended to the system prompt. The result is cached per prompt text so
//   it stays byte-stable across the rounds of one run (prompt-prefix cache).
// - `onStop` with `{continue: true}` — a post-run "discovery pass". When a
//   run that touched the repo would end, the mod injects one extra turn that
//   asks the model to propose durable facts as JSON — the same force-
//   continue mechanism hooku uses for haikus, here put to real work.
// - `prepareNextTurn` — model switching. The injected discovery turn is
//   routed to a cheap model (deepseek/deepseek-v4-flash by default), keeping
//   the main-loop model on real work.
// - `transformInput` — typed-input interception. The mod reads the user's
//   prompt (without changing it) so fact relevance can be scored per turn.
// - `afterToolCall` — activity tracking. The mod records which files the
//   run read or edited, so the discovery prompt knows what to focus on.
// - `onSessionStart` / `onSessionEnd` — lifecycle bookends. Each session
//   re-validates every fact against its source files and re-renders the
//   footer status; the footer is cleared on shutdown.
// - `addFlag` — `project-brain.discover` and `project-brain.model` as
//   first-class CLI options.
// - `addCommand` — `/brain` lists knowledge, queues discovery, forgets a
//   fact by id.
// - `addTool` — a read-only `project_brain_list` tool the model itself can
//   call to look up what the brain knows mid-task.
// - `cmd.ui.notify` / `cmd.ui.setStatus` — a 🧠 notify when a fact lands,
//   and a persistent fact-count footer segment.
// - Storage & invalidation — a hand-rolled JSONL store with content hashing
//   (node:crypto), zero external dependencies.
//
// ━━━ Storage format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
//   One JSON object per line in .commandcode/project-brain.jsonl:
//     {id, fact, evidence, sourceFiles: [{path, hash}], keywords,
//      confidence, status: 'active'|'stale', createdAt, updatedAt}
//
//   `hash` is a sha256 of the file's content (not its path or mtime), so a
//   fact survives checkouts and branch switches — and dies the moment its
//   code changes. `path` is relative to the repo root where possible, so the
//   store is portable across machines.
//
import type {ModApi} from '@commandcode/harness';
import {createHash} from 'node:crypto';
import {appendFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {bold, cyan, dim, green, red, yellow} from './colors';

// ── Limits ──────────────────────────────────────────────────────────────

const MAX_INJECT     = 6; // relevant facts injected per turn (with a prompt)
const GENERAL_INJECT = 3; // top-confidence facts injected before any prompt
const MAX_PROPOSE    = 5; // facts the discovery pass may propose per run

// ── Types ───────────────────────────────────────────────────────────────

interface SourceRef {
	readonly path: string; // relative to the repo root (or absolute if outside)
	readonly hash: string; // sha256 of the file content, first 12 hex chars
}

interface Fact {
	readonly id: string;
	readonly fact: string;
	readonly evidence: string;
	readonly sourceFiles: SourceRef[];
	readonly keywords: string[];
	readonly confidence: number;
	status: 'active' | 'stale';
	readonly createdAt: string;
	updatedAt: string;
}

// ── Small helpers ───────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

function asStr(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}

function genId(): string {
	return 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
	const STORE_PATH = join(cwd, '.commandcode', 'project-brain.jsonl');

	// In-memory store. storeVersion bumps on every write so the injected
	// block is rebuilt when the underlying data changes; injectedCache keeps
	// the block byte-stable across the rounds of one run otherwise.
	let storeFacts: Fact[] = [];
	let storeVersion = 0;
	let injectedCache: {key: string; value: string} | null = null;

	// Volatile state lives in the closure (never modState): it must not
	// survive resume, and modState must stay JSON-serializable.
	let initPromise: Promise<void> | null = null;
	let latestUserPrompt = '';                 // relevance source (transformInput)
	const repoFilesSeen = new Set<string>();   // files read/edited this run
	const lastCommands: string[] = [];         // recent inspect shell commands
	let learningPending = false;               // discovery turn is injected
	let forceLearn = false;                    // set by /brain learn
	let everLearnedThisSession = false;

	// ── Store helpers ──────────────────────────────────────────────────

	// Absolute path for a stored (possibly relative) source path.
	function absPath(p: string): string {
		return isAbsolute(p) ? p : join(cwd, p);
	}

	async function hashFileSafe(p: string): Promise<string | null> {
		try {
			const buf = await readFile(absPath(p));
			return createHash('sha256').update(buf).digest('hex').slice(0, 12);
		} catch {
			return null; // missing or unreadable file
		}
	}

	// Normalize a user/model-supplied path to a portable store path.
	function normalizePath(p: string): string | null {
		const abs = resolve(cwd, p);
		const rel = relative(cwd, abs);
		if (rel.startsWith('..')) return abs; // outside the repo — keep absolute
		return rel.split(sep).join('/');
	}

	async function loadStore(): Promise<void> {
		storeFacts = [];
		try {
			const body = await readFile(STORE_PATH, 'utf8');
			for (const line of body.split('\n')) {
				if (!line.trim()) continue;
				try {
					const f = JSON.parse(line) as Fact;
					if (typeof f?.fact === 'string' && typeof f?.id === 'string') {
						storeFacts.push(f);
					}
				} catch { /* skip a corrupt line */ }
			}
		} catch { /* no store yet */ }
		storeVersion++;
	}

	async function persistAll(): Promise<void> {
		await mkdir(dirname(STORE_PATH), {recursive: true});
		const body = storeFacts.map(f => JSON.stringify(f)).join('\n') +
			(storeFacts.length ? '\n' : '');
		await writeFile(STORE_PATH, body);
	}

	async function appendFact(f: Fact): Promise<void> {
		await mkdir(dirname(STORE_PATH), {recursive: true});
		await appendFile(STORE_PATH, JSON.stringify(f) + '\n');
		storeFacts.push(f);
		storeVersion++;
		injectedCache = null;
	}

	// The invalidation pass: any active fact whose source file content
	// changed (or vanished) since it was recorded is flipped to stale and
	// the store is rewritten, so the retirement is durable.
	async function invalidateStaleFacts(): Promise<void> {
		let dirty = false;
		for (const f of storeFacts) {
			if (f.status !== 'active') continue;
			for (const sf of f.sourceFiles) {
				const h = await hashFileSafe(sf.path);
				if (h !== sf.hash) {
					f.status = 'stale';
					f.updatedAt = new Date().toISOString();
					dirty = true;
					break;
				}
			}
		}
		if (dirty) {
			storeVersion++;
			await persistAll();
		}
	}

	// Single-flight lazy init: load + validate facts once per session.
	// Never rejects — an unreadable store degrades to "no facts".
	function ensureInit(): Promise<void> {
		if (!initPromise) {
			initPromise = (async () => {
				await loadStore();
				await invalidateStaleFacts();
			})().catch(() => {
				initPromise = null; // allow a retry next session
			});
		}
		return initPromise;
	}

	// ── Fact construction ──────────────────────────────────────────────

	// Turn one model-proposed object into a stored Fact (or null if junk):
	// requires a real sentence, and at least one verifiable source file.
	async function normalizeFact(raw: Record<string, unknown>): Promise<Fact | null> {
		const fact = asStr(raw.fact)?.trim() ?? '';
		const evidence = asStr(raw.evidence)?.trim() ?? '';
		if (!fact || fact.length < 12) return null; // too vague to be durable
		if (!evidence) return null;

		const keywords = (Array.isArray(raw.keywords) ? raw.keywords : [])
			.filter((k): k is string => typeof k === 'string')
			.map(k => k.trim())
			.filter(Boolean)
			.slice(0, 8);
		const confidence = clamp(Number(raw.confidence) || 0.7, 0, 1);

		const rawFiles = (Array.isArray(raw.sourceFiles) ? raw.sourceFiles : [])
			.filter((s): s is string => typeof s === 'string');
		const sourceFiles: SourceRef[] = [];
		for (const p of [...new Set(rawFiles)]) {
			const norm = normalizePath(p);
			if (!norm) continue;
			const hash = await hashFileSafe(norm);
			if (!hash) continue; // cited file doesn't exist — skip it
			sourceFiles.push({path: norm, hash});
		}
		if (!sourceFiles.length) return null; // nothing verifiable — reject

		const now = new Date().toISOString();
		return {
			id: genId(), fact, evidence, sourceFiles, keywords,
			confidence, status: 'active', createdAt: now, updatedAt: now,
		};
	}

	// Exact-normalized dedupe against already-stored facts.
	function isDuplicate(fact: string): boolean {
		const n = normText(fact);
		return storeFacts.some(f => normText(f.fact) === n);
	}

	// Extract a JSON array from the model's reply (fenced block or bare).
	function parseFactsJson(text: string): Array<Record<string, unknown>> {
		if (!text) return [];
		const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		const trimmed = (fenced ? fenced[1] : text).trim();
		const start = trimmed.indexOf('[');
		const end = trimmed.lastIndexOf(']');
		const slice = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
		try {
			const parsed = JSON.parse(slice) as unknown;
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	// Store every valid, non-duplicate fact the discovery pass proposed.
	async function ingestDiscoveryOutput(text: string): Promise<void> {
		let stored = 0;
		for (const raw of parseFactsJson(text)) {
			const fact = await normalizeFact(raw);
			if (!fact || isDuplicate(fact.fact)) continue;
			await appendFact(fact);
			stored++;
			cmd.ui.notify(`${green('✔')} ${dim('brain')} ${bold('Learned')}: ${truncate(fact.fact, 140)}`);
		}
		if (stored) updateStatus();
	}

	// ── Relevance scoring ──────────────────────────────────────────────

	// Score a fact against the current prompt: keyword / fact-text / source-
	// path overlap. Zero means "not relevant to this turn" and keeps the
	// fact out of the system prompt entirely.
	function scoreFact(f: Fact, promptText: string): number {
		if (!promptText.trim()) return f.confidence;
		const promptTokens = tokenize(promptText);
		const factText = f.fact.toLowerCase();
		const kw = new Set(f.keywords.map(k => k.toLowerCase()));
		let hits = 0;
		for (const t of promptTokens) {
			if (kw.has(t) || factText.includes(t) ||
				f.sourceFiles.some(sf => sf.path.toLowerCase().includes(t))) {
				hits++;
			}
		}
		if (hits === 0) return 0;
		return f.confidence * (0.5 + 0.5 * Math.min(1, hits / 2));
	}

	function formatFact(f: Fact, n: number): string {
		const src = f.sourceFiles.map(s => s.path).join(', ');
		return `${n}. ${f.fact}\n` +
			`   Evidence: ${truncate(f.evidence, 180)}\n` +
			`   Sources: ${src} (confidence ${f.confidence.toFixed(2)})`;
	}

	// Build the system-prompt block for this round. Cached by
	// (storeVersion, prompt text) so it is byte-stable across the rounds of
	// one run — the provider's prompt-prefix cache keys off those bytes.
	async function buildInjectedBlock(): Promise<string | undefined> {
		await ensureInit();
		const promptText = latestUserPrompt ?? '';
		const key = `${storeVersion}:${promptText}`;
		if (injectedCache?.key === key) return injectedCache.value || undefined;

		const active = storeFacts.filter(f => f.status === 'active');
		let pick: Fact[];
		if (promptText.trim()) {
			pick = active
				.map(f => ({f, s: scoreFact(f, promptText)}))
				.filter(x => x.s > 0)
				.sort((a, b) => b.s - a.s)
				.slice(0, MAX_INJECT)
				.map(x => x.f);
		} else {
			// No typed prompt yet (automated turns, headless) — the best
			// guess is the highest-confidence active facts.
			pick = [...active]
				.sort((a, b) => b.confidence - a.confidence)
				.slice(0, GENERAL_INJECT);
		}

		if (!pick.length) {
			injectedCache = {key, value: ''};
			return undefined;
		}
		const value =
			'[Project Brain — durable facts about this codebase]\n\n' +
			pick.map((f, i) => formatFact(f, i + 1)).join('\n\n') +
			'\n\n(Stored in .commandcode/project-brain.jsonl; code is the source of truth — verify against source if the files changed.)';
		injectedCache = {key, value};
		return value;
	}

	// ── Discovery pass ─────────────────────────────────────────────────

	function discoverEnabled(): boolean {
		return cmd.getFlag('project-brain.discover') !== false;
	}

	function learnModel(): string {
		const m = cmd.getFlag('project-brain.model');
		return typeof m === 'string' && m ? m : 'deepseek/deepseek-v4-flash';
	}

	// Concrete, data-driven prompt (pipes the actual files/commands the run
	// touched) asking for a JSON array of durable facts — parsed by
	// ingestDiscoveryOutput when the turn comes back.
	function discoveryPrompt(): string {
		const seen = [...repoFilesSeen];
		const commands = [...lastCommands];
		const scope = seen.length
			? `This run examined or edited: ${seen.join(', ')}`
			: 'This run did not touch the repo.';
		const cmdNote = commands.length
			? `\n\nInspect commands used this run:\n${commands.map(c => `  ${c}`).join('\n')}`
			: '';
		return (
			'Project Brain discovery pass.\n\n' +
			'Inspect the actual source files with tools, then reply with ONLY a JSON array ' +
			`of up to ${MAX_PROPOSE} NEW durable facts about this codebase — things that stay ` +
			'true for a long time and that a future session should know before working here ' +
			'(architecture locations, conventions, deprecations, invariants). Do not repeat ' +
			'the facts already injected into your system prompt.\n\n' +
			'Each entry must be exactly:\n' +
			'  {"fact": "...", "evidence": "...", "sourceFiles": ["rel/path", ...], "keywords": ["..."], "confidence": 0.9}\n\n' +
			'- fact: one specific, present-tense sentence.\n' +
			'- evidence: what you actually observed (file contents, calls, errors).\n' +
			'- sourceFiles: 1-3 real files supporting this fact, relative to the repo root.\n' +
			'- keywords: 2-6 short terms a future prompt would use when this fact matters.\n' +
			'- confidence: 0.0-1.0 — how sure you are.\n\n' +
			`${scope}${cmdNote}\n\n` +
			'Reply with ONLY one line of JSON — no prose, no markdown fences, no code block. ' +
			'If nothing is worth remembering, reply with exactly [].'
		);
	}

	// ── UI ─────────────────────────────────────────────────────────────

	function updateStatus(): void {
		const active = storeFacts.filter(f => f.status === 'active').length;
		const stale = storeFacts.length - active;
		cmd.ui.setStatus(
			`${green('🧠')} ${active} fact${active === 1 ? '' : 's'}` +
			(stale ? ` ${yellow(`(${stale} stale)`)}` : ''),
		);
	}

	function listFactsMessage(): string {
		if (!storeFacts.length) {
			return '🧠 No facts stored yet — run /brain learn or let a working session discover some.';
		}
		const rows = storeFacts.map(f => {
			const badge = f.status === 'active' ? '✅' : '⚠️ stale';
			const src = f.sourceFiles.map(s => s.path).join(', ');
			return `${badge} ${f.fact}\n` +
				`   ─ ${f.evidence}\n` +
				`   📎 ${src} · conf ${f.confidence.toFixed(2)} · ${f.id} · ${f.createdAt.slice(0, 10)}`;
		});
		return `🧠 Project Brain — ${storeFacts.length} fact(s)\n\n${rows.join('\n\n')}`;
	}

	function trackActivity(toolName: string, input: unknown): void {
		const inp = input as Record<string, unknown> | undefined;
		const fp = asStr(inp?.file_path);
		if (fp) repoFilesSeen.add(fp);
		if (toolName === 'glob') {
			const pattern = asStr(inp?.pattern);
			if (pattern) repoFilesSeen.add(pattern);
		}
		if (toolName === 'shell_command') {
			const command = asStr(inp?.command);
			if (command && /(?:cat|grep|rg|sed|ls|find|git|head|tail|less|more|awk)\b/.test(command)) {
				lastCommands.push(truncate(command, 120));
				if (lastCommands.length > 5) lastCommands.shift();
			}
		}
	}

	// ── Configuration ──────────────────────────────────────────────────

	cmd.addFlag('project-brain.discover', {
		type: 'boolean',
		default: true,
		description: 'Run a discovery pass after runs that touched the repo.',
	});
	cmd.addFlag('project-brain.model', {
		type: 'string',
		default: 'deepseek/deepseek-v4-flash',
		description: 'Cheap model used for the discovery pass.',
	});

	// ── Hooks ──────────────────────────────────────────────────────────

	cmd.hooks({

		/**
		 * onSessionStart — once per session. Re-validates every fact against
		 * its source files (a changed or deleted file retires the fact) and
		 * re-renders the footer count. Resets per-session learning state.
		 */
		onSessionStart: async () => {
			initPromise = null;      // force a fresh load + invalidation pass
			latestUserPrompt = '';
			learningPending = false;
			forceLearn = false;
			everLearnedThisSession = false;
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
		 * transformInput — the mods' typed-input seam. The brain only reads:
		 * the latest prompt becomes the relevance signal that decides which
		 * facts the next appendSystemPrompt injects.
		 */
		transformInput: ({text}) => {
			latestUserPrompt = text;
			return undefined; // pass the prompt through unchanged
		},

		/**
		 * appendSystemPrompt — the injection seam. Fires once per round with
		 * the resolved base prompt; the returned block is appended after it.
		 * Only facts scored as relevant to the current prompt are included,
		 * and the block is cached (storeVersion + prompt text) so it stays
		 * byte-stable across the rounds of one run.
		 */
		appendSystemPrompt: async () => buildInjectedBlock(),

		/**
		 * afterToolCall — activity tracking for the discovery prompt: which
		 * files the run examined or edited, and which inspect commands ran.
		 */
		afterToolCall: async ({toolName, input}) => {
			trackActivity(toolName, input);
			return undefined;
		},

		/**
		 * prepareNextTurn — model switching. Only when a discovery turn is
		 * pending does the brain route the next model call to the cheap
		 * model; every other turn runs on the session model.
		 */
		prepareNextTurn: () => {
			if (!learningPending) return undefined;
			return {model: learnModel()};
		},

		/**
		 * onStop — the force-continue seam that makes discovery possible.
		 * Phase 1: a run that touched the repo (or the session's first run,
		 * or an explicit /brain learn) would end → inject one discovery
		 * turn. Phase 2: the discovery turn finished → parse its JSON,
		 * store valid facts, notify 🧠, and let the run end.
		 */
		onStop: async ({lastAssistantText}) => {
			if (learningPending) {
				learningPending = false;
				await ingestDiscoveryOutput(lastAssistantText);
				return {continue: false};
			}
			if (!discoverEnabled()) return {continue: false};
			const shouldLearn =
				forceLearn || (repoFilesSeen.size > 0 && !everLearnedThisSession);
			if (!shouldLearn) return {continue: false};
			forceLearn = false;
			everLearnedThisSession = true;
			learningPending = true;
			cmd.ui.notify(`${dim('brain')} ${bold(cyan('Discovering facts'))} with ${learnModel()}...`);
			return {continue: true, reason: discoveryPrompt()};
		},

		/** onRunEnd — drop this run's activity so the next run starts clean. */
		onRunEnd: () => {
			repoFilesSeen.clear();
			lastCommands.length = 0;
		},
	});

	// ── Slash command: /brain ──────────────────────────────────────────

	cmd.addCommand({
		name: 'brain',
		description: 'Project Brain: list stored knowledge, queue discovery, forget a fact.',
		argumentHint: '[list | learn | forget <id>]',
		handler: async ({args}) => {
			await ensureInit();
			const [sub, id] = args.trim().split(/\s+/);

			switch (sub?.toLowerCase()) {
				case 'learn':
					forceLearn = true;
					return {
						message: '🧠 Discovery queued — it runs when this turn finishes.',
					};
				case 'forget': {
					const idx = storeFacts.findIndex(f => f.id === id);
					if (idx < 0) {
						return {
							message: `🧠 No fact with id "${id}". Run /brain to list them.`,
						};
					}
					const [removed] = storeFacts.splice(idx, 1);
					storeVersion++;
					injectedCache = null;
					await persistAll();
					updateStatus();
					return {message: `🧠 Forgotten: ${removed.fact}`};
				}
				default:
					return {message: listFactsMessage()};
			}
		},
	});

	// ── Cross-mod graduation ───────────────────────────────────────────

	// task-journal emits a durable-fact event when an episode reveals
	// something that stays true about the codebase (a lesson). Listen on
	// the mod bus and queue a discovery pass so the fact can graduate into
	// Project Brain — the journal holds episodes, the brain holds facts.
	cmd.events.on('task-journal:durable-fact', () => {
		if (!discoverEnabled()) return;
		forceLearn = true;
		cmd.ui.notify(`${cyan('↻')} ${dim('brain')} ${bold('Journal lesson queued')} for discovery.`);
	});

	// ── Tool: project_brain_list ───────────────────────────────────────

	cmd.addTool({
		schema: {
			name: 'project_brain_list',
			description:
				'List the durable facts the project-brain mod has learned about this ' +
				'codebase (architecture, conventions, deprecations). Read-only.',
			input_schema: {type: 'object', properties: {}, required: []},
		},
		readOnly: true,
		run: async () => {
			await ensureInit();
			return {
				ok: true,
				content: [{type: 'text', text: listFactsMessage()}],
			};
		},
	});

	// Kick the load off immediately so /brain and the first injection don't
	// race the file read.
	void ensureInit();
}
