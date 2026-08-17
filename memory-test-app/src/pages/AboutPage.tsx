import Badge from "../components/ui/Badge";
import Card from "../components/ui/Card";

const memoryMods = [
  {
    name: "task-journal",
    what: "Compresses each meaningful run into an episode: task, outcome, approaches, solution, lesson.",
    test: "Start a task here, change a file, let the run finish. Next session, ask for a similar task and see the episode injected.",
  },
  {
    name: "project-brain",
    what: "Learns durable facts about the codebase from what the agent actually does.",
    test: "Make an architectural decision in this app's code. Later, the brain should surface it as a fact with the source file.",
  },
];

export default function AboutPage() {
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          About
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-relaxed text-ink-muted sm:text-lg">
          This app is a minimal React + Tailwind playground. It exists to give
          the memory mods real files to read, change, and remember. Keep it
          small on purpose: every edit here is a candidate for an episode or a
          fact.
        </p>
      </section>

      <section aria-labelledby="memory-heading">
        <h2 id="memory-heading" className="text-xl font-semibold text-ink">
          The memory mods
        </h2>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {memoryMods.map((mod) => (
            <Card
              key={mod.name}
              title={mod.name}
              subtitle={mod.what}
              className="flex flex-col"
            >
              <p className="text-sm leading-relaxed text-ink-muted">
                {mod.test}
              </p>
              <div className="mt-4">
                <Badge tone="accent">Try it</Badge>
              </div>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
