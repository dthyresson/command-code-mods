// Mod: hex-color-swatch
//
// Two jobs, nothing else:
//
//  1. transformInput — when you TYPE a hex color like #fefefe, annotate it
//     inline with a 2-wide true-color swatch (`██ #fefefe`) before the model
//     sees it, so the model sees the color too.
//
//  2. Model output — when the model's reply contains hex colors, do NOT
//     regurgitate the response. Instead extract each unique color and render
//     a compact list of swatches:
//
//         ██ #fefefe
//         ██ #3b82f6
//
// No markdown-table re-rendering, no tool-result rewriting — just inline
// input swatches and a color list from the output.

import type { ModApi } from "@commandcode/harness";

// ── ANSI helpers ─────────────────────────────────────────────────────────────────────────
const ESC = "\u001b[";
const RESET = `${ESC}0m`;

/** Matches real 3/6-digit hex colors. */
const HEX_RE = /#([0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])/gi;

/** True if the text contains at least one hex color. */
const HAS_HEX = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i;

/** Render a 2-wide solid box (`██`) painted the given hex color. */
function swatch(hex: string): string {
  // ANSI 24-bit foreground:  \x1b[38;2;r;g;bm
  const [r, g, b] = parseHex(hex);
  return `${ESC}38;2;${r};${g};${b}m██${RESET}`;
}

/**
 * Convert `#rgb`/`#rrggbb` into `[r, g, b]`. Invalid → `[0, 0, 0]`.
 */
function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-f]{6}$/i.test(h)) return [0, 0, 0];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Replace every `#hex` in `text` with `██ #hex` (box painted the color). */
function annotate(text: string): string {
  return text.replace(HEX_RE, (_m, hex: string) => {
    const h =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    return `${swatch(h)} #${hex}`;
  });
}

/** Extract unique hex colors (normalized to 6-digit lowercase) in order. */
function extractColors(text: string): string[] {
  const seen = new Set<string>();
  const colors: string[] = [];
  for (const m of text.matchAll(HEX_RE)) {
    const hex = m[1].toLowerCase();
    const norm =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    if (!seen.has(norm)) {
      seen.add(norm);
      colors.push(norm);
    }
  }
  return colors;
}

/** Render the color list as a single line: `██ #hex ██ #hex …`. */
function colorLine(colors: string[]): string {
  return colors.map((c) => `${swatch(c)} #${c}`).join(" ");
}

export default function (cmd: ModApi): void {
  cmd.hooks({
    // Annotate typed hex input inline before the model sees it.
    transformInput: ({ text }) => {
      if (!HAS_HEX.test(text)) return { action: "continue" };
      return { action: "transform", text: annotate(text) };
    },

    // When the model output contains hex colors, show a color list feed row.
    // The response itself is NOT rewritten — the original text stays as-is.
    onStop: ({ lastAssistantText }) => {
      if (
        typeof lastAssistantText !== "string" ||
        !HAS_HEX.test(lastAssistantText)
      ) {
        return undefined;
      }
      const colors = extractColors(lastAssistantText);
      if (colors.length === 0) return undefined;
      cmd.showEntry("hex-colors", { colors });
      return undefined;
    },
  });

  // Render the color list feed row (single line).
  cmd.addRenderer("hex-colors", (data) => {
    const { colors } = data as { colors: string[] };
    return [colorLine(colors)];
  });
}
