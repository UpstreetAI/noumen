import Link from "next/link";
import { TerminalBlock } from "@/components/TerminalBlock";
import { HeroTerminal } from "@/components/HeroTerminal";
import { Sparkles } from "@/components/Sparkles";

const FEATURES = [
  {
    icon: "🔌",
    title: "Pluggable Providers",
    description:
      "Swap between OpenAI, Anthropic, and Google Gemini with a single config change. Bring-your-own-key, any model.",
  },
  {
    icon: "💻",
    title: "Virtual Infrastructure",
    description:
      "Run against local Node.js fs/child_process, or spin up remote containers via sprites.dev. Same API either way.",
  },
  {
    icon: "🛠️",
    title: "Built-in Tools",
    description:
      "ReadFile, WriteFile, EditFile, Bash, Glob, Grep — everything a coding agent needs, wired up out of the box.",
  },
  {
    icon: "📚",
    title: "Skills",
    description:
      "Inject markdown instructions into the system prompt. Inline or loaded from SKILL.md files on your virtual filesystem.",
  },
  {
    icon: "💾",
    title: "Sessions",
    description:
      "Conversations persist as JSONL. Resume where you left off, auto-compact when context gets large.",
  },
  {
    icon: "🔗",
    title: "MCP Support",
    description:
      "Connect to any Model Context Protocol server. Expose external tools and resources to the agent seamlessly.",
  },
];

const PROVIDERS = [
  { name: "OpenAI", model: "gpt-4o" },
  { name: "Anthropic", model: "claude-sonnet-4" },
  { name: "Google Gemini", model: "gemini-2.5-flash" },
];

const CODE_EXAMPLE = `import {
  Code,
  OpenAIProvider,
  LocalFs,
  LocalComputer,
} from "noumen";

const code = new Code({
  aiProvider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  virtualFs: new LocalFs({ basePath: "/my/project" }),
  virtualComputer: new LocalComputer({ defaultCwd: "/my/project" }),
});

const thread = code.createThread();

for await (const event of thread.run("Add a health-check endpoint")) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "tool_use_start":
      console.log(\`\\n[tool] \${event.toolName}\`);
      break;
    case "tool_result":
      console.log(\`[result] \${event.result.content.slice(0, 200)}\`);
      break;
  }
}`;

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
          {/* Left: copy */}
          <div className="min-w-0 flex flex-col gap-6">
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[var(--color-accent-blue-dim)] bg-[var(--color-accent-blue-dim)] px-3 py-1 text-xs font-medium text-[var(--color-accent-blue)]">
              <span>🐍</span> pluggable coding agent
            </div>

            <h1 className="font-[family-name:var(--font-display)] text-4xl font-extrabold leading-[1.08] tracking-tight text-[var(--color-text-primary)] sm:text-5xl lg:text-6xl">
              One library.
              <br />
              <span className="bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] bg-clip-text text-transparent">
                Every provider.
              </span>
            </h1>
            <p className="max-w-lg text-lg leading-relaxed text-[var(--color-text-secondary)]">
              A headless, API-only coding agent that reads, writes, edits files,
              runs commands, and searches codebases — backed by any LLM and any
              filesystem.
            </p>

            <div className="flex flex-col gap-1.5 text-xs font-medium tracking-wide text-[var(--color-text-tertiary)] uppercase sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-1">
              <div className="flex items-center gap-4">
                <span>Provider-agnostic</span>
                <span className="text-[var(--color-accent-blue-dim)]">
                  ✦
                </span>
                <span>Virtual infrastructure</span>
              </div>
              <span className="hidden sm:inline text-[var(--color-accent-blue-dim)]">
                ✦
              </span>
              <div className="flex items-center gap-4">
                <span>Async iterable</span>
                <span className="text-[var(--color-accent-blue-dim)]">
                  ✦
                </span>
                <span>MIT licensed</span>
              </div>
            </div>

            <TerminalBlock command="pnpm add noumen" className="max-w-lg" />

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

          {/* Right: animated terminal */}
          <div className="relative hidden lg:block">
            <div className="animate-float">
              <HeroTerminal />
            </div>
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="relative py-24 sm:py-32">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-[var(--color-accent-blue-dim)] to-transparent opacity-30" />
        <div className="relative mx-auto max-w-6xl px-6">
          <h2 className="font-[family-name:var(--font-display)] text-center text-3xl font-bold tracking-tight text-[var(--color-text-primary)] sm:text-4xl">
            Everything you need to build a coding agent
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-center text-[var(--color-text-secondary)]">
            Pluggable providers, virtual filesystems, built-in tools, and
            session management — all in one package.
          </p>

          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <div
                key={feature.title}
                className="group flex flex-col gap-3 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-base-card)] p-6 transition hover:border-[var(--color-accent-blue)] hover:-translate-y-1 hover:shadow-lg hover:shadow-[var(--color-accent-blue-dim)]"
              >
                <div className="text-2xl">{feature.icon}</div>
                <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                  {feature.title}
                </h3>
                <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Code example ── */}
      <section className="relative overflow-hidden py-24 sm:py-32">
        <div className="absolute inset-0 bg-[var(--color-base-surface)]" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[var(--color-accent-blue-dim)] via-transparent to-[var(--color-accent-cyan-dim)] opacity-40" />
        <div className="relative mx-auto max-w-6xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <div className="mb-4 inline-block rounded-full border border-[var(--color-accent-blue)] bg-[var(--color-accent-blue-dim)] px-3 py-1 text-xs font-medium text-[var(--color-accent-blue)]">
              Quick Start
            </div>
            <h2 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight sm:text-4xl bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] bg-clip-text text-transparent">
              Up and running in minutes.
            </h2>
            <p className="mt-4 text-[var(--color-text-secondary)]">
              Pick a provider, point at a filesystem, and start streaming events.
            </p>
          </div>

          <div className="mx-auto mt-10 max-w-3xl rounded-xl border border-[var(--color-border-default)] bg-[var(--color-base-body)] p-5 font-mono text-sm leading-6 shadow-2xl overflow-x-auto">
            <div className="mb-4 flex items-center gap-2">
              <div className="h-3 w-3 rounded-full bg-[#ff5f57]" />
              <div className="h-3 w-3 rounded-full bg-[#febc2e]" />
              <div className="h-3 w-3 rounded-full bg-[#28c840]" />
              <span className="ml-2 text-xs text-[var(--color-text-tertiary)]">
                index.ts
              </span>
            </div>
            <pre className="text-[var(--color-text-secondary)] whitespace-pre">
              <code>{CODE_EXAMPLE}</code>
            </pre>
          </div>
        </div>
      </section>

      {/* ── Provider strip ── */}
      <section className="py-24 sm:py-32">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="font-[family-name:var(--font-display)] text-center text-3xl font-bold tracking-tight text-[var(--color-text-primary)] sm:text-4xl">
            Adapters for everything
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-center text-[var(--color-text-secondary)]">
            Swap providers with a single line. Same streaming interface, same
            tool loop, same results.
          </p>

          <div className="mx-auto mt-12 grid max-w-3xl gap-6 sm:grid-cols-3">
            {PROVIDERS.map((p) => (
              <div
                key={p.name}
                className="group flex flex-col items-center gap-3 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-base-card)] p-8 text-center transition hover:border-[var(--color-accent-blue)] hover:shadow-lg hover:shadow-[var(--color-accent-blue-dim)]"
              >
                <h3 className="text-lg font-bold text-[var(--color-text-primary)]">
                  {p.name}
                </h3>
                <code className="rounded-md bg-[var(--color-base-body)] px-3 py-1.5 font-mono text-xs text-[var(--color-accent-cyan)]">
                  {p.model}
                </code>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Bottom CTA ── */}
      <section className="relative overflow-hidden py-24 sm:py-32">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[var(--color-accent-blue-dim)] to-transparent" />
        <div className="relative mx-auto max-w-2xl px-6 text-center">
          <div className="mb-4 text-5xl">🐍</div>
          <h2 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight text-[var(--color-text-primary)] sm:text-4xl">
            Start building.
            <br />
            <span className="bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] bg-clip-text text-transparent">
              Ship an agent today.
            </span>
          </h2>
          <div className="mt-8 space-y-2 text-left">
            <TerminalBlock command="pnpm add noumen" />
            <TerminalBlock command='import { Code, OpenAIProvider } from "noumen"' />
          </div>
          <Link
            href="/docs/getting-started"
            className="mt-8 inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] px-5 py-2.5 text-sm font-semibold text-[var(--color-base-body)] transition hover:shadow-lg hover:shadow-[var(--color-accent-blue-dim)]"
          >
            Read the quickstart
            <span aria-hidden="true">&rarr;</span>
          </Link>
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
          <p className="text-xs text-[var(--color-text-tertiary)]">
            &copy; {new Date().getFullYear()} noumen &mdash; MIT License
          </p>
        </div>
      </footer>
    </>
  );
}
