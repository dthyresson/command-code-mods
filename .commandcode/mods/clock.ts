// ── Agent Clock — multi-zone world clock in the TUI footer ───────────────
//
// The clock sits persistently at the bottom of the screen (via `cmd.ui.setStatus`)
// and updates live ~every 8 seconds *and* right before every tool call. This means
// the time is always fresh even if you stare at the agent loop for a long time.
//
// ━━━ How it works — lifecycle ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
//   1. `onSessionStart` fires **once when a session begins** (startup, resume).
//      We kick off an 8-second interval timer here — it runs independently of
//      the agent loop and calls refreshClock() on its own schedule.
//      We also do an immediate refresh so the clock shows up right away instead
//      of waiting for the first tick.
//
//   2. `beforeToolCall` fires **every time the model decides to call a tool**.
//      We use this as a secondary refresh mechanism so that if the interval has
//      just fired or is about to fire, the clock gets updated no matter what
//      the model is working on. This guarantees freshness before the model sees
//      a tool result. Both hooks return `undefined` (no mutation) — a common
//      pattern for hooks that only observe/clean-up.
//
//   3. `onSessionEnd` fires **once when a session shuts down** (interrupted,
//      replaced, finished). We clear our interval here so we don't leak timers
//      into another session. The Disposable pattern: if we had registered via
//       `addRenderer` or `widget`, disposal would come from the handle; since
//       we own setInterval directly, cleanup is manual.
//
// ━━━ How it works — display ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
//   `refreshClock()` builds the full display string (local + all configured
//   extra zones), reads the 12 h / 24 h flag, and pushes the result to
//   `cmd.ui.setStatus`. setStatus writes a single per-mod segment in the TUI
//   footer — new calls replace old text; whitespace-only clears it. Multiple
//   mods render their segments side-by-side in load order.
//
// ━━━ Emoji system ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
//   EMOJIS[0–23] maps each local hour to one character from four palettes:
//   ☀️ = day sun    |  🌕/🌑/🌗 = moon phases     |  🌅 = dawn/sunset
//   Midnight (0) = full moon 🌕 · Noon (12) = full sun ☀️
//
// What this mod demonstrates of the Command Code mod API:
// - **`addFlag` + `getFlag`** — configurable timezone slots (tz1/tz2/tz3) and
//   format (12 h ↔ 24 h). Each flag has a built-in default when left blank.
// - **`onSessionStart`** — once-per-session wake-up bookend. Used here to
//   start the interval timer and do an immediate first render. Carries a
//   typed `source` param (resume vs. startup) the bare session_start event
//   doesn't expose.
// - **`onSessionEnd`** — once-per-session shutdown bookend. Used here to
//   clear our interval so we never leak a running timer across sessions.
// - **`beforeToolCall`** — reactive hook that fires before every tool
//   invocation. The clock uses this for a guaranteed-refresh point whenever
//   the model performs any action. Returning undefined means "no opinion"
//   (don't block, don't rewrite).
// - **`setStatus`** — persistent footer segment (not transient `notify`).
//   One segment per mod painted side-by-side in load order. Headless: stored,
//   rendered nowhere.
// - **Slash commands** — `/clock format` shows the current setting;
//   `/clock tz1|2|3 <zone>` tells users how to set a slot via --mod-option.
// - **Intl.DateTimeFormat** — native timezone parsing, offset extraction, and
//   locale-aware formatting. Zero external dependencies.
//
import type {ModApi} from '@commandcode/harness';

// ━━━ Emoji system ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
//   Four palettes — no half-moon crescents that render like clouds:
//   ☀️ = daytime sun      |  🌅 = dawn / sunset glow
//   🌕🌑🌗 = moon phases   |  ✨ = starry deep night
//
//   Midnight (hour 0) = full moon 🌕 · Noon (hour 12) = full sun ☀️
const EMOJIS: readonly string[] = [
	'🌕', // 0   midnight · full moon
	'✨', // 1   late night · starry sky
	'✨', // 2   pre-dawn · stars still visible
	'🌑', // 3   predawn light · new moon (dark sky)
	'🌅', // 4   almost dawn · rising sun glow
	'🌅', // 5   dawn break · sunrise begins
	'☀️', // 6   sunrise · sun up
	'☀️', // 7   morning · sun
	'☀️', // 8   mid-morning · sun
	'☀️', // 9   late morning · sun
	'☀️', // 10  near noon · sun
	'☀️', // 11  approaching noon · sun
	'☀️', // 12  noon · full sun
	'☀️', // 13  early afternoon · sun
	'☀️', // 14  mid-afternoon · sun
	'☀️', // 15  late afternoon · sun
	'🌅', // 16  evening · sun dipping below horizon
	'🌑', // 17  dusk transition · new moon
	'🌅', // 18  sunset · orange glow
	'🌗', // 19  evening glow · waxing moon
	'🌗', // 20  early night · last quarter
	'✨', // 21  night · stars
	'✨', // 22  late night · stars
	'✨', // 23  deep night · stars
];

// Returns the emoji for the given local hour. Uses modulo + abs-wrap for
// negative-hour safety (shouldn't happen, but guards against bugs).
function getEmojiForHour(h: number): string {
	return EMOJIS[((h % 24) + 24) % 24];
}

// ── Timezone helpers ─────────────────────────────────────────────────────

// Build a readable timezone label: "City (+/-HH)" using Intl.
// Splits on '/' to extract the city name, replaces underscores with spaces,
// then uses Intl.DateTimeFormat with timeZoneName:'longOffset' to extract
// the UTC offset string appended after "GMT".
function tzLabel(tzStr: string, refTime: Date): string {
	try {
		const parts = tzStr.split('/');
		const city = parts[parts.length - 1]?.replace(/_/g, ' ') ?? tzStr;
		// Use the timeZoneName:'longOffset' fragment to pull out "+/-HH".
		const formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: tzStr, timeZoneName: 'longOffset',
		});
		const formatted = formatter.format(refTime);
		const m = formatted.match(/GMT([+-]\d+)?$/i);
		return m && m[1] ? `${city} ${m[1]}` : city;
	} catch {
		return tzStr;
	}
}

// Format a datetime in the given timezone string (hour/min/sec with optional 12 h).
function formatInZone(date: Date, tz: string, format24: boolean): string {
	try {
		return date.toLocaleString('en-US', {
			timeZone: tz,
			hour: '2-digit', minute: '2-digit', second: '2-digit',
			hour12: !format24,
		});
	} catch {
		return '--:--:--';
	}
}

// Resolve effective timezone value: use the flag if non-blank, otherwise fall
// back to the provided default. Enables slot-based config where leaving a
// flag empty reverts to the sensible built-in default.
function effectiveTZ(slot: string | undefined, def: string): string {
	return (slot && slot.trim() !== '') ? slot!.trim() : def;
}

// Detect the user's local timezone from the runtime locale. Falls back to
// America/New_York (a reasonable default) if detection fails.
function detectLocalTZ(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone;
	} catch {
		return 'America/New_York';
	}
}

// ── Mod factory ──────────────────────────────────────────────────────────

export default function(cmd: ModApi): void {
	// ── Closure state ──────────────────────────────────────────────────
	//
	// These variables live in the factory's closure scope. They persist for the
	// lifetime of the process (until /reload restarts it). We use the closure
	// rather than modState because clock data is ephemeral — it doesn't need
	// to survive session resumption.

	let intervalId: ReturnType<typeof setInterval> | null = null; // Timer handle
	let lastFormat24    = true;                                   // Track format across ticks

	// Built-in defaults for each optional slot (empty string means "use default").
	const TZ_DEFAULTS = ['', 'Europe/London', 'America/Los_Angeles', 'Australia/Sydney'];

	// ── Display builders ───────────────────────────────────────────────

	// Return the local-timezone entry object. Runs once per refresh.
	function localInfo(now: Date) {
		const h = now.getHours();
		const localTz = detectLocalTZ();
		return [{
			label: tzLabel(localTz, now),
			time:  formatInZone(now, localTz, lastFormat24),
			emoji: getEmojiForHour(h),
		}];
	}

	// Return all extra timezone entries. Reads each flag and applies defaults.
	function extraLines(now: Date): Array<{label: string; time: string; emoji: string}> {
		const fmt24 = !cmd.getFlag('clock.format') || cmd.getFlag('clock.format') === '24';
		const extras: Array<{label: string; time: string; emoji: string}> = [];

		// Resolve effective values: custom override or built-in default.
		const slots = [
			effectiveTZ(cmd.getFlag('clock.tz1') as string | undefined, TZ_DEFAULTS[1]),
			effectiveTZ(cmd.getFlag('clock.tz2') as string | undefined, TZ_DEFAULTS[2]),
			effectiveTZ(cmd.getFlag('clock.tz3') as string | undefined, TZ_DEFAULTS[3]),
		];

		for (let i = 0; i < 3; i++) {
			if (!slots[i]) continue; // Skip blanks — slot not configured.
			try {
				// Extract the local hour in this timezone for emoji selection.
				const h = (() => {
					const d = new Date(now.toLocaleString('en-US', {timeZone: slots[i]}));
					return d.getHours();
				})();
				extras.push({
					label: tzLabel(slots[i], now),
					time:  formatInZone(now, slots[i], fmt24),
					emoji: getEmojiForHour(h),
				});
			} catch { /* Ignore invalid timezone strings silently */ }
		}
		return extras;
	}

	// Combine local + extras into the full display string (one line per zone).
	function fullDisplay(now: Date): string {
		const lines: string[] = [];
		localInfo(now).forEach(z => lines.push(`[${z.time}] ${z.label} ${z.emoji}`));
		extraLines(now).forEach(z => lines.push(`[${z.time}] ${z.label} ${z.emoji}`));
		return lines.join('\n');
	}

	// Refresh function — the single source of truth for updating the UI.
	// Called by: onSessionStart (initial), interval timer (every 8 s),
	//            and beforeToolCall (guaranteed refresh on activity).
	function refreshClock(): void {
		lastFormat24 = !cmd.getFlag('clock.format') || cmd.getFlag('clock.format') === '24';
		const fmt = lastFormat24 ? '24 h' : '12 h';
		cmd.ui.setStatus(fullDisplay(new Date())
			? `⏰ Clock (${fmt})\n${fullDisplay(new Date())}`
			: `⏰ Clock (${fmt})`);
	}

	// ── Lifecycle hooks ────────────────────────────────────────────────
	//
	// Hooks are the **mutating** surface of the mod API — they can change
	// behavior, block operations, inject work, or drive UI updates. The clock
	// uses three hooks, each at a different granularity:
	//
	//   • onSessionStart    → once per session     (start timer, first render)
	//   • onSessionEnd      → once per session     (stop timer, cleanup)
	//   • beforeToolCall    → every tool invocation (force-fresh refresh)

	cmd.hooks({

		/**
		 * onSessionStart — fires **once** when a session begins.
		 *
		 * This is the session's "wake up" moment. It carries a typed `source`
		 * field (the hook receives `{source}` in the destructured params):
		 *   - `'startup'`  → brand-new session
		 *   - `'resume'`   → session was restored from a prior save
		 *
		 * The clock uses this to:
		 *   1. Call refreshClock() immediately so the clock appears on-screen
		 *      without waiting for the first interval tick.
		 *   2. Start an 8-second setInterval that keeps ticking until
		 *      onSessionEnd tears it down.
		 *
		 * Why not just use setInterval alone? Because interval callbacks
		 * fire regardless of what's happening — even during long idle gaps
		 * where the agent loop hasn't run a turn yet. Combined with the
		 * beforeToolCall hook, the clock stays fresh whether the model is
		 * actively working or resting between turns.
		 */
		onSessionStart: () => {
			refreshClock();
			intervalId = setInterval(() => refreshClock(), 8_000);
		},

		/**
		 * onSessionEnd — fires **once** when a session shuts down.
		 *
		 * This is the session's "sleep" moment. Common reasons:
		 *   - `'replaced'` → user switched to a different session
		 *   - `'abort'`    → user interrupted (Ctrl+C)
		 *   - `'finished'` → normal completion
		 *
		 * The clock's job here is purely cleanup: clearInterval prevents
		 * the timer from leaking into the next session (which would cause
		 * double-ticks if the user starts a new session without reloading).
		 */
		onSessionEnd: () => {
			if (intervalId) {
				clearInterval(intervalId);
				intervalId = null;
			}
		},

		/**
		 * beforeToolCall — fires **before every tool invocation**.
		 *
		 * This is the clock's secondary freshness mechanism. While the
		 * interval handles background updates, this hook guarantees a
		 * refresh right before the model observes a tool result. Useful
		 * scenarios:
		 *
		 *   - The user switches branches → session resumes → beforeToolCall
		 *     fires on the very first tool call to render the clock instantly.
		 *   - Long-running tools (shell_command, read_file on large dirs) →
		 *     the interval may have fired, but this ensures the display is
		 *     as current as possible before the result lands.
		 *   - Rapid tool chains → each call triggers a refresh, giving the
		 *     user a real-time ticking feel.
		 *
		 * Returning `undefined` means "no opinion": don't block the call,
		 * don't rewrite its input, don't modify results. A hook can also
		 * return `{block: true}` (stops the tool), `{input: ...}` (rewrites
		 * input), or `{terminate: true}` (ends the session). The clock uses
		 * only the observation capability — it mutates nothing.
		 */
		beforeToolCall: async () => {
			refreshClock();
			return undefined;
		},
	});

	// ── Slash command ──────────────────────────────────────────────────
	//
	// Slash commands are user-invoked shortcuts registered via `cmd.addCommand`.
	// The handler receives `{args, ui, cwd, exec}` and returns DATA:
	//   - `{prompt}`        → injects an automated model turn
	//   - `{message}`       → renders an info row in the feed
	//   - `undefined`       → pure side effect, no visible output

	cmd.addCommand({
		name: 'clock',
		description: 'Agent clock: show times, toggle format, set timezone slots.',
		handler: ({args, ui}) => {
			const sub = args[0]?.toLowerCase();
			const fmt24 = !cmd.getFlag('clock.format') || cmd.getFlag('clock.format') === '24';

			if (!sub) {
				// Bare `/clock` → show current display inline.
				return {message: `⏰ Clock (${fmt24 ? '24 h' : '12 h'})\n${fullDisplay(new Date())}`};
			}

			switch (sub) {
				case 'format':
					return {
						message: `Current: ${fmt24 ? '24-hour' : '12-hour'} format.\n` +
							'To change: restart with --mod-option clock.format=12 (or 24).',
					};

				case 'tz1': case 'tz2': case 'tz3': {
					return {
						message: `To set ${sub}: restart with --mod-option clock.${sub}=<timezone>\n` +
							`Example: cmd --mod-option clock.${sub}=Asia/Tokyo\n` +
							`(Leave blank to use the built-in default.)`,
					};
				}

				case 'help': case '-h': case '--help':
					return {
						message:
							'⏰ Agent Clock\n' +
							'  /clock                  — show current times\n' +
							'  /clock format           — check current format\n' +
							'  /clock tz1 <zone>       — instruction on setting slot 1\n' +
							'  /clock tz2 <zone>       — instruction on setting slot 2\n' +
							'  /clock tz3 <zone>       — instruction on setting slot 3\n' +
							'\nValid timezone strings:\n' +
							'  Asia/Tokyo, Europe/Paris, America/Chicago, ...\n' +
							'  Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones',
					};

				default:
					return {message: `Unknown "/clock ${sub}". Try /clock help.`};
			}
		},
	});
}
