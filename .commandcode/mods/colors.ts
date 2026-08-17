// ── Shared ANSI color helpers ─────────────────────────────────────────────
//
// A tiny picocolors-style helper for mods that want styled `cmd.ui.notify`
// / `cmd.ui.setStatus` output. Zero dependencies — raw SGR escape codes.
//
// Usage (from any mod in .commandcode/mods/):
//
//   import {c, dim, green, bold} from './colors';
//   cmd.ui.notify(`${c.green('✔')} ${dim('journal')} ${bold('Journaled')}`);
//
// All helpers no-op to the plain string when ANSI is not supported
// (isColorSupported), so headless output stays clean.
//
// Supported: reset, bold, dim, italic, underline, inverse, strikethrough,
// black/red/green/yellow/blue/magenta/cyan/white, bright variants, and
// bg* background variants. Colors accept a string and return the wrapped
// string (chainable: c.bold(c.green('x'))).

const isColorSupported =
  typeof process !== 'undefined' &&
  process.stdout &&
  (process.stdout.isTTY || process.env.FORCE_COLOR !== undefined) &&
  process.env.NO_COLOR === undefined;

function wrap(open: number, close: number) {
  return (s: string): string =>
    isColorSupported ? `\u001b[${open}m${s}\u001b[${close}m` : s;
}

// Named exports mirror picocolors' API surface for the common cases.
export const reset = wrap(0, 0);
export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const underline = wrap(4, 24);
export const inverse = wrap(7, 27);
export const strikethrough = wrap(9, 29);

export const black = wrap(30, 39);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const white = wrap(37, 39);
export const gray = wrap(90, 39);

export const bgBlack = wrap(40, 49);
export const bgRed = wrap(41, 49);
export const bgGreen = wrap(42, 49);
export const bgYellow = wrap(43, 49);
export const bgBlue = wrap(44, 49);
export const bgMagenta = wrap(45, 49);
export const bgCyan = wrap(46, 49);
export const bgWhite = wrap(47, 49);

// Chained accessor object for ergonomic one-liners: c.bold(c.green('✓')).
export const c = {
  reset,
  bold,
  dim,
  italic,
  underline,
  inverse,
  strikethrough,
  black,
  red,
  green,
  yellow,
  blue,
  magenta,
  cyan,
  white,
  gray,
  bgBlack,
  bgRed,
  bgGreen,
  bgYellow,
  bgBlue,
  bgMagenta,
  bgCyan,
  bgWhite,
};
