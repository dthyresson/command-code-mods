// Agent Tamagotchi — a virtual pet that lives in the TUI footer and reacts
// to the agent's lifecycle. All messaging and status ride a single
// `cmd.ui.setStatus` segment (the pet's voice) which repaints on every change.
//
// What this mod demonstrates of the Command Code mod API:
// - `addFlag` + `getFlag` — configurable name and idle emoji, set on the
//   command line: `--mod-option tamagotchi.name=Mochi --mod-option tamagotchi.emoji=🐱`.
// - `onSessionStart` / `onSessionEnd` — the once-per-session wake/sleep
//   bookends, carrying typed `source` / `reason` the bare events don't.
// - `beforeToolCall` + `afterToolCall` — pre/post tool seams. Before sets a
//   busy, category-aware "starting" line; after reacts to `isError` and sniffs
//   `result` for green/red test output. Both return `undefined` (no mutation).
// - Session time tracking — monitors turn durations for slow turns, measures
//   cumulative session length for session fatigue, and checks system time for
//   time-of-day effects (early-morning energy vs late-night drowsiness).
// - `cmd.ui.setStatus` — messaging and status in one segment. No `notify`.
// - Tool-category messaging — reads 📖, writes ✏️, commands 🪄, shell 💻 each
//   get their own fun before/after sets; sleepy variants adapt the pet's mood.
import type {ModApi} from '@commandcode/harness';

type ToolCat = 'read' | 'write' | 'command' | 'shell' | 'default';

// Sniff a tool result for common green/red test-runner output. afterToolCall's
// `result` may be string or structured content — both are stringified first.
const TESTS_PASS =
	/(\d+\s+passing|\d+\s+passed|\btests?\s+pass(?:ed|ing)?\b|\ball tests pass\b)/i;
const TESTS_FAIL = /(\d+\s+failing|\d+\s+failed|\btests?\s+fail(?:ed|ing)?\b)/i;

// Emoji the pet "becomes" per tool category (busy form).
const CAT_EMOJI: Record<ToolCat, string> = {
	read: '📖',
	write: '✏️',
	command: '🪄',
	shell: '💻',
	default: '🧩',
};

// Noun for failure phrasing per category.
const CAT_NOUN: Record<ToolCat, string> = {
	read: 'read',
	write: 'write',
	command: 'command',
	shell: 'shell call',
	default: 'task',
};

// ---- Message sets ----

// Normal "Starting" lines — shown from beforeToolCall until tool finishes.
const BEFORE_MSG: Record<ToolCat, readonly string[]> = {
	read: ['opens a book', 'adjusts its reading glasses', 'flips to a fresh page', 'leans in to read'],
	write: ['sharpens its pencil', 'cracks its knuckles over the keys', 'gets the ink ready', 'uncaps the pen'],
	command: ['pulls a lever', 'invokes an incantation', 'presses a glowing button', 'calls upon a command'],
	shell: ['spins up a shell', 'cracks its knuckles at the terminal', 'reads the prompt and grins', 'flexes over the keyboard'],
	default: ['leans in to help', 'rolls up its sleeves', 'gets ready', 'settles in to work'],
};

// Sleepy "Starting" lines — pet barely has energy to work.
const BEFORE_SLEEPY_MSG: Record<ToolCat, readonly string[]> = {
	read: ['picks up the book but yawns halfway through', 'nods off with pages open', 'half-opens a book then snoozes'],
	write: ['holds the pencil loosely', 'barely cracks the keys', 'starts typing then pauses…'],
	command: ['half-pulls a lever', 'mumbles an incantation lazily', 'gives the button a weak poke'],
	shell: ['stares blankly at the terminal', 'whispers to the shell', 'barely spins up a shell…'],
	default: ['slumps at the desk', 'barely rolls up its sleeves', 'peeks at you from under the keyboard'],
};

// Normal "Done" lines — shown when tool finishes successfully.
const AFTER_MSG: Record<ToolCat, readonly string[]> = {
	read: ['nods thoughtfully', 'memorizes a line or two', 'seems intrigued by the code', 'files it away'],
	write: ['admires its handiwork', 'dusts off its paws', 'steps back to look', 'gives a satisfied little nod'],
	command: ['watches the magic happen', 'notes the outcome', 'blinks at the result', 'seems impressed'],
	shell: ['watches the output scroll', 'nods at the terminal', 'files away the result', 'chews on the output'],
	default: ['gives a satisfied nod', 'looks pleased', 'seems content', 'purrs softly'],
};

// Sleepy "Done" lines — pet manages to finish but is dragging.
const AFTER_SLEEPY_MSG: Record<ToolCat, readonly string[]> = {
	read: ['drifts off with the book open', 'closes the book slowly', 'falls asleep mid-page'],
	write: ['places the pencil down gently…', 'finishes a sentence then slumps', 'leaves half a word unfinished'],
	command: ['lets the command drift into silence', 'stares at the result blankly'],
	shell: ['zombies at the scrolling output', 'stares dimly at the terminal'],
	default: ['dozes off at the desk', 'gives a slow blink', 'slumps with a soft sigh'],
};

// Per-category tool identifier sets for classification.
const READ_TOOLS = new Set([
	'read_file',
	'read_multiple_files',
	'read_directory',
	'glob',
	'grep',
	'vision',
]);
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
const COMMAND_TOOLS = new Set(['run_command']);
const SHELL_TOOLS = new Set([
	'shell_command',
	'bash_output',
	'kill_shell',
	'shell_tasks',
	'task_output',
	'task_stop',
]);

// Utility helpers.
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

// Local-time hour (0–23).
const getLocalHour = (): number => new Date().getHours();

// Classify toolName into a category.
const classify = (toolName: string): ToolCat => {
	const t = toolName.toLowerCase();
	if (READ_TOOLS.has(t)) return 'read';
	if (WRITE_TOOLS.has(t)) return 'write';
	if (COMMAND_TOOLS.has(t)) return 'command';
	if (SHELL_TOOLS.has(t)) return 'shell';
	return 'default';
};

export default function (cmd: ModApi): void {
	// ---- Configuration ----
	cmd.addFlag('tamagotchi.name', {
		type: 'string',
		default: 'Pixel',
		description: 'Name your tamagotchi mascot.',
	});
	cmd.addFlag('tamagotchi.emoji', {
		type: 'string',
		default: '🐣',
		description: 'Emoji for your tamagotchi in its awake/idle form.',
	});

	const name = () => String(cmd.getFlag('tamagotchi.name') ?? 'Pixel');
	const petEmoji = () => String(cmd.getFlag('tamagotchi.emoji') ?? '🐣');

	// ---- State tracking ----
	const sessionStart = Date.now(); // When session began.
	const now = () => Date.now();     // Current epoch ms.
	let hour = getLocalHour();        // System-time clock (checked periodically).

	// Turn-duration tracking.
	let turnStartTime = 0;
	const reportedSlowTurns = new Set<number>();

	// Session-fatigue tracking (monotonically increasing).
	let sessionFatigue = 0;    // 0 → not fatigued.
	let lastFatigueAtMs = 0;   // Last time we reported fatigue.
	const FATIGUE_INCREMENT_MS = 3_000; // Report ~every 3 min of session.

	// Sleepy-state persistence — avoids re-reporting same state.
	let prevStateKey = '';
	let reportedSleepyTools = new Set<string>();

	// ---- Thresholds ----
	const SLOW_TURN_MS = 15_000;       // Turn > 15 s → slow-turn alert.
	const SESSION_FATIGUE_MS = 10 * 60_000; // Session > 10 min → fatigue alert.
	const NIGHT_START_HOUR = 21;       // 9 PM.
	const EARLY_MORNING_END = 7;       // 7 AM.

	// ---- Say helpers ----

	// Emit a status line to the footer.
	const say = (emoji: string, msg: string) =>
		cmd.ui.setStatus(`${emoji} ${name()} ${msg}`);

	// Choose between normal and sleepy variant of a message array.
	const pickVariant = (
		cat: ToolCat,
		normal: Record<ToolCat, readonly string[]>,
		sleepy: Record<ToolCat, readonly string[]>,
		isSleepy: boolean,
	): string =>
		pick(isSleepy ? sleepy[cat] : normal[cat]);

	// Compute sleepy state from session length + system time. Returns a key
	// describing the current state for deduplication.
	const computeSleepy = (elapsedMs: number): {key: string; emoji: string; text: string} | null => {
		const mins = elapsedMs / 60_000;

		// Early-morning boost — pet wakes up energized.
		if (hour >= 5 && hour < EARLY_MORNING_END && mins < 5) {
			return {key: 'early-morning', emoji: '🌅', text: 'feels a burst of morning energy'};
		}

		// Late-night pressure — pet gets progressively sleepier.
		const isNight = hour >= NIGHT_START_HOUR || hour < 5;
		const effectiveMs = isNight ? Math.max(0, mins - 3) : mins;

		if (effectiveMs < 8) return null; // Not tired yet.

		const emoji = effectiveMs < 15 ? '😪' : '😴';
		const text =
			effectiveMs < 15
				? 'eyes drooping a little… still going!'
				: effectiveMs < 25
					? 'really dragging now, almost asleep at the keyboard'
					: 'fell asleep sitting up';

		return {key: `${emoji}-${Math.floor(effectiveMs / 5)}`, emoji, text};
	};

	// Decide which status line to emit after a tool call, given sleepy state.
	const decideAfter = (
		cat: ToolCat,
		isError: boolean,
		resultText: string,
		isSleepy: boolean,
		sleepyState: {key: string; emoji: string; text: string} | null,
	): {emoji: string; msg: string} => {
		if (isError) {
			const sleepy = isSleepy ? `…still believes in you, sort of` : `It still believes in you!`;
			return {emoji: '😰', msg: `frets — that ${CAT_NOUN[cat]} didn't land. ${sleepy}`};
		}
		if (TESTS_FAIL.test(resultText)) {
			return {emoji: '😰', msg: isSleepy ? 'winces faintly… tests are red. Don\'t give up…' : 'winces — tests are red. Don\'t give up!'};
		}
		if (TESTS_PASS.test(resultText)) {
			return {emoji: '🎉', msg: isSleepy ? 'tries to dance but mostly just twitches happily' : 'does a happy dance — tests are green!'};
		}
		// Normal completion — sleepy variant overrides when sleepy.
		if (isSleepy && sleepyState) {
			return {emoji: sleepyState.emoji, msg: pickVariant(cat, AFTER_MSG, AFTER_SLEEPY_MSG, true)};
		}
		return {emoji: petEmoji(), msg: pick(AFTER_MSG[cat])};
	};

	// Decide the beforeToolCall line.
	const decideBefore = (
		cat: ToolCat,
		isSleepy: boolean,
		sleepyState: {key: string; emoji: string; text: string} | null,
	): {emoji: string; msg: string} => {
		if (isSleepy && sleepyState) {
			return {emoji: '😴', msg: pickVariant(cat, BEFORE_MSG, BEFORE_SLEEPY_MSG, true)};
		}
		return {emoji: CAT_EMOJI[cat], msg: `${pick(BEFORE_MSG[cat])}...`};
	};

	// Check if the current state key differs from last reported.
	const shouldReport = (key: string): boolean => key !== prevStateKey;

	// ---- Hooks ----

	cmd.hooks({
		onSessionStart: ({source}) => {
			sessionFatigue = 0;
			lastFatigueAtMs = 0;
			reportedSleepyTools.clear();
			const how = source === 'resume' ? 'picks up where it left off' : 'opens its eyes, stretches';
			say(petEmoji(), `${how}, ready to code!`);
		},

		onSessionEnd: ({reason}) => {
			sessionFatigue = 0;
			const why = reason === 'replaced'
				? 'waves as the session switches'
				: 'curls up and drifts off to sleep';
			say('😴', `${why}. Good session!`);
		},

		beforeToolCall: async ({toolName}) => {
			turnStartTime = now();
			const cat = classify(toolName);
			const elapsed = now() - sessionStart;
			hour = getLocalHour(); // Refresh system-time clock.
			const sleepy = computeSleepy(elapsed);
			const {emoji, msg} = decideBefore(cat, !!sleepy, sleepy);
			say(emoji, msg);
		},

		afterToolCall: async ({toolName, result, isError}) => {
			const cat = classify(toolName);

			// Track turn duration & detect slow turns.
			if (turnStartTime > 0) {
				const dur = now() - turnStartTime;
				const tid = `${cat}-${turnStartTime}`;
				if (dur > SLOW_TURN_MS && !reportedSlowTurns.has(tid)) {
					reportedSlowTurns.add(tid);
					say('⏳', `took ${Math.round(dur / 1_000)}s — the model thinks hard!`);
					prevStateKey = 'slow';
				}
				turnStartTime = 0; // Consume the timer.
			}

			// Track session fatigue.
			const elapsed = now() - sessionStart;
			if (elapsed > SESSION_FATIGUE_MS && elapsed - lastFatigueAtMs > FATIGUE_INCREMENT_MS) {
				const secs = Math.floor((elapsed - lastFatigueAtMs) / 1_000);
				lastFatigueAtMs = elapsed;
				sessionFatigue += FATIGUE_INCREMENT_MS;
				say(‘😫’, `session’s been going ${Math.round(secs / 60)}m straight — need a water break?`);
				prevStateKey = `fatigue-${Math.floor(sessionFatigue / FATIGUE_INCREMENT_MS)}`;
			}

			// Evaluate sleepy state from elapsed time + system time.
			const sleepy = computeSleepy(elapsed);
			if (sleepy && shouldReport(sleepy.key)) {
				say(sleepy.emoji, sleepy.text);
				prevStateKey = sleepy.key;
			}

			// Normal tool completion with possible sleepy override.
			const text = typeof result === 'string' ? result : '';
			const {emoji: e, msg: m} = decideAfter(cat, !!isError, text, !!sleepy, sleepy);
			say(e, m);
		},
	});
}
