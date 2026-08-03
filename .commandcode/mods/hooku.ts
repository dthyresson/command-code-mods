// A Command Code mod is a plugin that extends the agent loop. It exports a
// single function that receives the ModApi (cmd) and registers capabilities —
// flags, hooks, and UI feedback — on it. See the README for what each
// capability demonstrates.
import type {ModApi} from '@commandcode/harness';

// Cap on how much run output gets fed to the haiku model.
const MAX_OUTPUT = 3_000;

// When the run output is too long, sample the start, middle, and end rather
// than truncating the head — this gives the model representative coverage of
// the whole run instead of just its opening.
function sampleText(text: string, max: number): string {
  if (text.length <= max) return text;

  const third = Math.floor(max / 3);
  const start = text.slice(0, third);
  const mid = text.slice(
    Math.floor(text.length / 2) - Math.floor(third / 2),
    Math.floor(text.length / 2) + Math.floor(third / 2),
  );
  const end = text.slice(-third);

  return `${start}\n_\n${mid}\n_\n${end}`;
}

export default function (cmd: ModApi): void {
  // Flags: a mod can register its own CLI options, read back at runtime via
  // cmd.getFlag. Users set them with --mod-option <name>=<value>, e.g.
  // --mod-option hooku.enabled=false.
  cmd.addFlag('hooku.enabled', {
    type: 'boolean',
    default: true,
    description: 'Compose a haiku poem after each run ends',
  });

  cmd.addFlag('hooku.model', {
    type: 'string',
    default: 'deepseek/deepseek-v4-flash',
    description: 'Model to use for haiku generation',
  });

  // State shared across the two turns of the haiku flow.
  let haikuPending = false;
  let runOutput = '';

  cmd.hooks({
    // prepareNextTurn runs before each turn and can return a model to switch
    // to. While a haiku is pending, route the next turn to the configured
    // (cheaper) haiku model instead of the main-loop model.
    prepareNextTurn: async () => {
      if (haikuPending) {
        const model = String(cmd.getFlag('hooku.model') ?? 'deepseek/deepseek-v4-flash');
        return {model};
      }
      return undefined;
    },

    // onStop fires when a run would otherwise end. Returning
    // {continue: true, reason} forces one extra turn with a custom prompt —
    // this is the core mechanism for injecting follow-up work into the loop.
    // The hook fires again on that follow-up turn, so the flow is two-phase:
    //   1) first onStop  → haikuPending false → kick off the haiku turn
    //   2) second onStop → haikuPending true  → the haiku came back
    onStop: async ({lastAssistantText}) => {
      if (!cmd.getFlag('hooku.enabled')) return undefined;

      if (!haikuPending) {
        // Phase 1: sample the run output and force one more turn asking the
        // haiku model to turn it into a poem.
        haikuPending = true;
        runOutput = sampleText(lastAssistantText ?? '', MAX_OUTPUT);
        const model = String(cmd.getFlag('hooku.model') ?? 'deepseek/deepseek-v4-flash');

        // cmd.ui.notify shows transient status to the user without touching
        // the run's own output.
        cmd.ui.notify(`Writing hooku with ${model}...`);

        return {
          continue: true,
          reason: `Write a 5-7-5 haiku poem about this run's output:\n\n${runOutput}\n\nReply with only the three-line haiku, no other text.`,
        };
      }

      // Phase 2: the haiku arrived as the assistant's reply to our injected
      // turn. Just report the outcome.
      haikuPending = false;
      const haiku = (lastAssistantText ?? '').trim();

      if (haiku) {
        cmd.ui.notify(`Done.`);
      } else {
        cmd.ui.notify(`Something went wrong. Please try again.`);
      }

      return undefined;
    },
  });
}
