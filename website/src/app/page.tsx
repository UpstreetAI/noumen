import Link from "next/link";
import { TerminalBlock } from "@/components/TerminalBlock";
import { HeroTerminal } from "@/components/HeroTerminal";
import { AdapterStack } from "@/components/AdapterStack";
import { Sparkles } from "@/components/Sparkles";
import { EasterEggFooter } from "@/components/EasterEggFooter";

const FEATURES = [
  {
    icon: "🛠️",
    title: "Read, write, edit, execute",
    description:
      "ReadFile, WriteFile, EditFile, Bash, Glob, Grep, WebFetch, NotebookEdit, AskUser — the same tools shipping inside production coding agents, wired up and ready to go.",
  },
  {
    icon: "🔌",
    title: "Six providers, one interface",
    description:
      "OpenAI, Anthropic, Google Gemini, OpenRouter, AWS Bedrock, Google Vertex AI. Same streaming interface, same tool dispatch, same results. Bring your own keys.",
  },
  {
    icon: "💻",
    title: "Four sandbox backends",
    description:
      "Local Node.js, sprites.dev containers, Docker, or E2B cloud. Swap one line to move from zero isolation to a fully sandboxed remote environment.",
  },
  {
    icon: "💾",
    title: "Resume, compact, persist",
    description:
      "Conversations save as JSONL. Auto-compaction, microcompact, and reactive strategies keep context under control. Resume any thread by ID.",
  },
  {
    icon: "🔗",
    title: "MCP, LSP, ACP, A2A",
    description:
      "Connect to MCP servers for external tools. Query language servers via LSP. Expose your agent over HTTP/WebSocket with the built-in server, or use ACP and A2A protocol adapters.",
  },
  {
    icon: "🔒",
    title: "Permissions and safety",
    description:
      "Six permission modes from full auto to plan-only. Per-tool rules, denial tracking, and an optional AI classifier. Git safety guards built in.",
  },
  {
    icon: "🧠",
    title: "Extended thinking",
    description:
      "Unified thinking config across providers. Anthropic budget_tokens, OpenAI reasoning_effort, Gemini thinkingBudget — one option, any model.",
  },
  {
    icon: "📚",
    title: "Skills and project context",
    description:
      "Load SKILL.md files with conditional activation. Drop a NOUMEN.md or CLAUDE.md in your repo for automatic project instructions. Hierarchical scoping from enterprise to local.",
  },
  {
    icon: "💰",
    title: "Cost tracking and observability",
    description:
      "Built-in token usage and USD cost tracking with per-model pricing. OpenTelemetry tracing integration. Retry with exponential backoff and model fallback.",
  },
  {
    icon: "🤖",
    title: "Multi-agent and subagents",
    description:
      "Spawn isolated subagents for focused subtasks. Run a swarm of agents in parallel with message passing and configurable concurrency.",
  },
  {
    icon: "🧩",
    title: "Structured output",
    description:
      "Request JSON output with schema validation. Works alongside tools or as a final response. Supports JSON Schema and JSON object modes.",
  },
  {
    icon: "🗂️",
    title: "Tasks, plans, and worktrees",
    description:
      "Built-in task management tools for decomposing work. Plan mode for read-only exploration. Git worktrees for isolated branch-based experimentation.",
  },
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
          {/* Left: copy */}
          <div className="min-w-0 flex flex-col gap-6">
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[var(--color-accent-blue-dim)] bg-[var(--color-accent-blue-dim)] px-3 py-1 text-xs font-medium text-[var(--color-accent-blue)]">
              <span>🐍</span> coding agent SDK
            </div>

            <h1 className="font-[family-name:var(--font-display)] text-4xl font-extrabold leading-[1.08] tracking-tight text-[var(--color-text-primary)] sm:text-5xl lg:text-6xl">
              Coding agents are products.
              <br />
              This is the{" "}
              <span className="bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] bg-clip-text text-transparent">
                library.
              </span>
            </h1>
            <p className="max-w-lg text-lg leading-relaxed text-[var(--color-text-secondary)]">
              The tool loop, file editing, shell execution, and session
              management that power coding agents &mdash; as a composable npm
              package. Every layer is a swappable adapter.
            </p>

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

          {/* Right: interactive adapter stack */}
          <div className="min-w-0">
            <AdapterStack />
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="relative py-24 sm:py-32">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-[var(--color-accent-blue-dim)] to-transparent opacity-30" />
        <div className="relative mx-auto max-w-6xl px-6">
          <h2 className="font-[family-name:var(--font-display)] text-center text-3xl font-bold tracking-tight text-[var(--color-text-primary)] sm:text-4xl">
            The missing layer between LLMs and codebases
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-center text-[var(--color-text-secondary)]">
            The tool loop, session management, and virtual infrastructure
            that every coding agent needs — so you don&apos;t have to build it yourself.
          </p>

          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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

      {/* ── See it run ── */}
      <section className="relative overflow-hidden py-24 sm:py-32">
        <div className="absolute inset-0 bg-[var(--color-base-surface)]" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[var(--color-accent-blue-dim)] via-transparent to-[var(--color-accent-cyan-dim)] opacity-40" />
        <div className="relative mx-auto max-w-6xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight sm:text-4xl bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] bg-clip-text text-transparent">
              A real agent run.
            </h2>
            <p className="mt-4 text-[var(--color-text-secondary)]">
              One prompt. The agent reads files, edits code, runs tests,
              and reports back &mdash; all through the tool loop.
            </p>
          </div>
          <div className="mx-auto mt-10 max-w-3xl">
            <HeroTerminal />
          </div>
        </div>
      </section>

      {/* ── Bottom CTA ── */}
      <section className="relative overflow-hidden py-24 sm:py-32">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[var(--color-accent-blue-dim)] to-transparent" />
        <div className="relative mx-auto max-w-2xl px-6 text-center">
          <div className="mb-4 text-5xl">🐍</div>
          <h2 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight text-[var(--color-text-primary)] sm:text-4xl">
            Every layer plugs in.
            <br />
            <span className="bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] bg-clip-text text-transparent">
              Ship yours.
            </span>
          </h2>
          <div className="mt-8 space-y-2 text-left">
            <TerminalBlock command="pnpm add noumen" />
            <TerminalBlock command='import { Code } from "noumen"' />
            <TerminalBlock command='import { OpenAIProvider } from "noumen/openai"' />
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
          <EasterEggFooter />
        </div>
      </footer>
    </>
  );
}
