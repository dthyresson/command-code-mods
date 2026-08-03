import type {ModApi} from '@commandcode/harness';

const MAX_OUTPUT = 3_000;

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

  cmd.addRenderer('hooku/haiku', data => {
    const lines = (data as {lines: string[]}).lines;
    return ['', ...lines.map(l => `  ▸ ${l}`), ''];
  });

  let haikuPending = false;
  let runOutput = '';

  cmd.hooks({
    prepareNextTurn: async () => {
      if (haikuPending) {
        const model = String(cmd.getFlag('hooku.model') ?? 'deepseek/deepseek-v4-flash');
        return {model};
      }
      return undefined;
    },

    onStop: async ({lastAssistantText}) => {
      if (!cmd.getFlag('hooku.enabled')) return undefined;

      if (!haikuPending) {
        haikuPending = true;
        runOutput = sampleText(lastAssistantText ?? '', MAX_OUTPUT);
        const model = String(cmd.getFlag('hooku.model') ?? 'deepseek/deepseek-v4-flash');

        cmd.ui.notify(`Writing hooku with ${model}...`);

        return {
          continue: true,
          reason: `Write a 5-7-5 haiku poem about this run's output:\n\n${runOutput}\n\nReply with only the three-line haiku, no other text.`,
        };
      }

      haikuPending = false;
      const haiku = (lastAssistantText ?? '').trim();
      const lines = haiku.split('\n').filter(l => l.trim()).slice(0, 3);

      if (lines.length) {
        cmd.ui.notify(`Done.`);
      } else {
        cmd.ui.notify(`Something went wrong. Please try again.`);
      }

      return undefined;
    },
  });
}
