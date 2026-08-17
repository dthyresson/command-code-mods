import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";

const samples = [
  {
    label: "Task journal",
    description: "Cross-session episodic memory. Feed it multi-step tasks and see past episodes resurface.",
  },
  {
    label: "Project brain",
    description: "Durable codebase facts. Make architecture decisions and watch them get learned and injected.",
  },
];

export default function HomePage() {
  return (
    <div className="space-y-10">
      <section>
        <Badge tone="brand" className="mb-3">
          Memory mods test bench
        </Badge>
        <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          Hello, memory
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-relaxed text-ink-muted sm:text-lg">
          A deliberately small React app for poking at the memory mods. Do real
          work, change files, run tests, then check whether{" "}
          <span className="font-semibold text-ink">task-journal</span> and{" "}
          <span className="font-semibold text-ink">project-brain</span> remember
          it next session.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => alert("Hello from memory-test-app")}>
            Say hello
          </Button>
          <Button variant="secondary" onClick={() => alert("No hidden state here yet")}>
            No-op button
          </Button>
        </div>
      </section>

      <section aria-labelledby="mods-heading">
        <h2 id="mods-heading" className="text-xl font-semibold text-ink">
          What to try
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {samples.map((sample) => (
            <Card key={sample.label} title={sample.label}>
              <p className="text-sm leading-relaxed text-ink-muted">
                {sample.description}
              </p>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="state-heading">
        <h2 id="state-heading" className="text-xl font-semibold text-ink">
          UI states
        </h2>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button disabled>Disabled</Button>
          <Button variant="secondary" disabled>
            Disabled secondary
          </Button>
          <Badge tone="neutral">Neutral badge</Badge>
          <Badge tone="brand">Brand badge</Badge>
          <Badge tone="accent">Accent badge</Badge>
        </div>
      </section>
    </div>
  );
}
