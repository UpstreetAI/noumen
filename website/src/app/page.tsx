import Link from "next/link";
import { TerminalBlock } from "@/components/TerminalBlock";
import { HeroTerminal } from "@/components/HeroTerminal";
import { AdapterStack } from "@/components/AdapterStack";
import { CodeSnippet } from "@/components/CodeSnippet";
import { Sparkles } from "@/components/Sparkles";
import { EasterEggFooter } from "@/components/EasterEggFooter";

const FEATURE_BLOCKS = [
  {
    title: "Seven providers, one interface",
    description:
      "Switch models by changing one string. Same streaming, same tool dispatch.",
    filename: "index.ts",
    code: `// swap the string — nothing else changes
const agent = new Agent({ provider: "anthropic", cwd: "." });

// or use any of the 7 providers:
// "openai" | "anthropic" | "gemini" | "openrouter"
// | "bedrock" | "vertex" | "ollama"`,
  },
  {
    title: "Seven sandbox backends",
    description:
      "Swap one line to change the isolation boundary — local to cloud to SSH.",
    filename: "index.ts",
    code: `import { Agent } from "noumen";
import { LocalSandbox } from "noumen/local";
import { SshSandbox } from "noumen/ssh";

// local development
const agent = new Agent({ provider, sandbox: LocalSandbox({ cwd: "." }) });

// production — same agent, remote sandbox over SSH
const agent = new Agent({ provider, sandbox: SshSandbox({ host: "dev.example.com", cwd: "/workspace" }) });`,
  },
  {
    title: "Nine built-in tools",
    description:
      "The same tools inside production coding agents, wired up and ready to go.",
    filename: "terminal",
    code: `$ npx noumen "Add input validation to signup"

  [ReadFile]   src/handlers/signup.ts
  [EditFile]   src/handlers/signup.ts  +14 lines
  [Bash]       npm test -- signup
  ✓ All 9 tests passed
  turn_complete  tokens: 2,847  cost: $0.03`,
  },
  {
    title: "Resume, compact, persist",
    description:
      "Conversations save as JSONL. Resume any thread by ID.",
    filename: "resume.ts",
    code: `const thread = agent.createThread({ threadId: "feature-auth" });

// picks up exactly where it left off
for await (const ev of thread.run("Continue from the last change")) {
  // ...
}`,
  },
  {
    title: "Multi-agent orchestration",
    description:
      "Spawn isolated subagents for focused subtasks with configurable concurrency.",
    filename: "swarm.ts",
    code: `const thread = agent.createThread();

for await (const ev of thread.run("Refactor auth and add tests")) {
  if (ev.type === "subagent_start") {
    console.log(\`  spawned: \${ev.name}\`); // "test-writer"
  }
}`,
  },
  {
    title: "MCP, LSP, hooks, and more",
    description:
      "Connect external tools, query language servers, intercept everything.",
    filename: "config.ts",
    code: `const agent = new Agent({
  provider: "anthropic",
  mcpServers: {
    filesystem: { command: "npx", args: ["-y", "@mcp/server-fs", "/tmp"] },
  },
  lsp: {
    typescript: { command: "typescript-language-server", args: ["--stdio"] },
  },
});`,
  },
];

const QUICKSTART_STEPS = [
  {
    title: "Install",
    description: "One package. No peer dependencies.",
    code: "npm install noumen",
    isShell: true,
  },
  {
    title: "Configure",
    description: "Pick a provider and a sandbox.",
    code: `import { Agent } from "noumen";
import { LocalSandbox } from "noumen/local";

const agent = new Agent({
  provider: "anthropic",
  sandbox: LocalSandbox({ cwd: "." }),
});`,
    isShell: false,
  },
  {
    title: "Run",
    description: "Stream events from the agent loop.",
    code: `const thread = agent.createThread();

for await (const event of thread.run("Fix the auth bug")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}`,
    isShell: false,
  },
  {
    title: "Ship",
    description: "Embed in your app, or run the CLI.",
    code: `# zero-config interactive agent
$ npx noumen`,
    isShell: true,
  },
];

const AND_MORE = [
  { label: "Permissions", href: "/docs/permissions" },
  { label: "Structured output", href: "/docs/getting-started" },
  { label: "Cost tracking", href: "/docs/getting-started" },
  { label: "Skills & context", href: "/docs/getting-started" },
  { label: "18 hook events", href: "/docs/hooks" },
  { label: "Embed anywhere", href: "/docs/embedding" },
  { label: "Thinking", href: "/docs/getting-started" },
];

export default function Home() {
  return (
    <>
      {/* ── Hero ── */}
      <section className="relative flex min-h-[calc(100vh-3.5rem)] flex-col justify-center overflow-hidden px-6 py-20">
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
          style={{
            background:
              "radial-gradient(ellipse 80% 50% at 30% 20%, rgba(96,165,250,0.08) 0%, transparent 70%), radial-gradient(ellipse 60% 40% at 70% 70%, rgba(34,211,238,0.06) 0%, transparent 70%)",
          }}
        />

        <Sparkles />

        <div className="relative z-10 mx-auto grid w-full max-w-6xl items-center gap-12 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0 flex flex-col gap-6">
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[var(--color-accent-blue-dim)] bg-[var(--color-accent-blue-dim)] px-3 py-1 text-xs font-medium text-[var(--color-accent-blue)]">
              <span>🤲</span> hands for your LLM
            </div>

            <h1 className="font-[family-name:var(--font-display)] text-4xl font-extrabold leading-[1.08] tracking-tight text-[var(--color-text-primary)] sm:text-5xl lg:text-6xl">
              An agent that{" "}
              <span className="bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] bg-clip-text text-transparent">
                reads, writes, and executes.
              </span>
            </h1>
            <p className="max-w-lg text-lg leading-relaxed text-[var(--color-text-secondary)]">
              File editing, shell execution, context management, and
              sandboxing &mdash; any provider, any sandbox, one package.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/docs"
                className="group inline-flex w-fit items-center gap-2 rounded-lg bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] px-5 py-2.5 text-sm font-semibold text-[var(--color-base-body)] transition hover:shadow-lg hover:shadow-[var(--color-accent-blue-dim)]"
              >
                Read the docs
                <span
                  aria-hidden="true"
                  className="transition-transform group-hover:translate-x-0.5"
                >
                  &rarr;
                </span>
              </Link>
              <a
                href="https://github.com/UpstreetAI/noumen"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-2 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-base-surface)] px-5 py-2.5 text-sm font-semibold text-[var(--color-text-primary)] transition hover:border-[var(--color-accent-blue)]"
              >
                GitHub
              </a>
            </div>
          </div>

          <div className="min-w-0">
            <AdapterStack />
          </div>
        </div>
      </section>

      {/* ── See it in action ── */}
      <section className="relative overflow-hidden py-20 sm:py-28">
        <div className="absolute inset-0 bg-[var(--color-base-surface)]" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[var(--color-accent-blue-dim)] via-transparent to-[var(--color-accent-cyan-dim)] opacity-40" />
        <div className="relative mx-auto max-w-6xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight sm:text-4xl bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] bg-clip-text text-transparent">
              Zero config to a coding agent.
            </h2>
            <p className="mt-4 text-[var(--color-text-secondary)]">
              <code className="rounded bg-[var(--color-base-card)] px-1.5 py-0.5 font-mono text-sm text-[var(--color-text-primary)]">
                npx noumen
              </code>{" "}
              starts an interactive agent in your terminal. No config, no
              signup.
            </p>
          </div>
          <div className="mx-auto mt-10 max-w-3xl">
            <HeroTerminal />
          </div>
        </div>
      </section>

      {/* ── Features — 6 themed blocks with code ── */}
      <section className="relative py-24 sm:py-32">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-[var(--color-accent-blue-dim)] to-transparent opacity-30" />
        <div className="relative mx-auto max-w-6xl px-6">
          <h2 className="font-[family-name:var(--font-display)] text-center text-3xl font-bold tracking-tight text-[var(--color-text-primary)] sm:text-4xl">
            Everything between the LLM and the computer
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-center text-[var(--color-text-secondary)]">
            Other SDKs lock you to one model or make you build the tools
            yourself. Noumen ships the full stack so you ship the agent.
          </p>

          <div className="mt-16 flex flex-col gap-16">
            {FEATURE_BLOCKS.map((block, i) => {
              const isEven = i % 2 === 0;
              return (
                <div
                  key={block.title}
                  className={`grid items-center gap-8 lg:grid-cols-2 ${isEven ? "" : "lg:direction-rtl"}`}
                >
                  <div className={`flex flex-col gap-3 ${isEven ? "" : "lg:order-2"}`}>
                    <span className="font-mono text-sm font-bold text-[var(--color-accent-blue)]">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <h3 className="font-[family-name:var(--font-display)] text-xl font-bold text-[var(--color-text-primary)] sm:text-2xl">
                      {block.title}
                    </h3>
                    <p className="max-w-md text-[var(--color-text-secondary)]">
                      {block.description}
                    </p>
                  </div>
                  <div className={isEven ? "" : "lg:order-1"}>
                    <CodeSnippet
                      code={block.code}
                      filename={block.filename}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* And more */}
          <div className="mt-20 text-center">
            <p className="mb-6 text-sm font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">
              And more
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              {AND_MORE.map((item) => (
                <Link
                  key={item.label}
                  href={item.href}
                  className="rounded-full border border-[var(--color-border-default)] bg-[var(--color-base-card)] px-4 py-2 text-sm text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-blue)] hover:text-[var(--color-accent-blue)]"
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Quickstart ── */}
      <section className="relative py-24 sm:py-32">
        <div className="relative mx-auto max-w-3xl px-6">
          <h2 className="font-[family-name:var(--font-display)] text-center text-3xl font-bold tracking-tight text-[var(--color-text-primary)] sm:text-4xl">
            Get started in{" "}
            <span className="bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] bg-clip-text text-transparent">
              four steps.
            </span>
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-center text-[var(--color-text-secondary)]">
            From install to running agent in under a minute.
          </p>

          <div className="relative mt-14">
            <div className="absolute left-[19px] top-0 bottom-0 w-px bg-[var(--color-border-default)] hidden sm:block" />

            <div className="flex flex-col gap-12">
              {QUICKSTART_STEPS.map((step, i) => (
                <div key={step.title} className="relative flex gap-6">
                  <div className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--color-accent-blue)] bg-[var(--color-base-body)] font-mono text-sm font-bold text-[var(--color-accent-blue)]">
                    {String(i + 1).padStart(2, "0")}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1">
                    <div>
                      <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">
                        {step.title}
                      </h3>
                      <p className="text-sm text-[var(--color-text-secondary)]">
                        {step.description}
                      </p>
                    </div>
                    {step.isShell ? (
                      <TerminalBlock command={step.code} />
                    ) : (
                      <CodeSnippet
                        code={step.code}
                        filename={step.title.toLowerCase() + ".ts"}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Bottom CTA ── */}
      <section className="relative overflow-hidden py-24 sm:py-32">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[var(--color-accent-blue-dim)] to-transparent" />
        <div className="relative mx-auto max-w-2xl px-6 text-center">
          <h2 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight text-[var(--color-text-primary)] sm:text-4xl">
            Three imports to a{" "}
            <span className="bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] bg-clip-text text-transparent">
              coding agent.
            </span>
          </h2>
          <p className="mt-4 text-[var(--color-text-secondary)]">
            Read the quickstart, browse the docs, or just run{" "}
            <code className="rounded bg-[var(--color-base-card)] px-1.5 py-0.5 font-mono text-sm text-[var(--color-text-primary)]">
              npx noumen
            </code>{" "}
            and go.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/docs/getting-started"
              className="group inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] px-5 py-2.5 text-sm font-semibold text-[var(--color-base-body)] transition hover:shadow-lg hover:shadow-[var(--color-accent-blue-dim)]"
            >
              Read the quickstart
              <span
                aria-hidden="true"
                className="transition-transform group-hover:translate-x-0.5"
              >
                &rarr;
              </span>
            </Link>
            <a
              href="https://github.com/UpstreetAI/noumen"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-base-surface)] px-5 py-2.5 text-sm font-semibold text-[var(--color-text-primary)] transition hover:border-[var(--color-accent-blue)]"
            >
              GitHub
            </a>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-[var(--color-border-default)] py-12">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-6 sm:flex-row sm:justify-between">
          <div className="flex items-center gap-6 text-sm text-[var(--color-text-tertiary)]">
            <Link
              href="/docs"
              className="transition hover:text-[var(--color-accent-blue)]"
            >
              Docs
            </Link>
            <a
              href="https://github.com/UpstreetAI/noumen"
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:text-[var(--color-accent-blue)]"
            >
              GitHub
            </a>
            <a
              href="https://www.npmjs.com/package/noumen"
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:text-[var(--color-accent-blue)]"
            >
              npm
            </a>
          </div>
          <EasterEggFooter />
        </div>
      </footer>
    </>
  );
}
