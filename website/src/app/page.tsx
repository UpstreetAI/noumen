import Link from "next/link";
import { TerminalBlock } from "@/components/TerminalBlock";
import { HeroTerminal } from "@/components/HeroTerminal";
import { AdapterStack } from "@/components/AdapterStack";
import { Sparkles } from "@/components/Sparkles";
import { EasterEggFooter } from "@/components/EasterEggFooter";

const USE_CASES = [
  {
    icon: "💻",
    title: "Coding agents",
    prompt: "Refactor the auth module and add tests",
    description:
      "The primary use case. Read, write, edit files, run tests, manage git — the full coding loop with sandboxed isolation.",
  },
  {
    icon: "📊",
    title: "Data analysis",
    prompt: "Analyze sales.csv and produce a summary report",
    description:
      "Read datasets, run scripts, write outputs. The same file + shell primitives that power coding agents handle data pipelines too.",
  },
  {
    icon: "🔧",
    title: "DevOps & infrastructure",
    prompt: "Check the deploy logs and rollback if errors spiked",
    description:
      "Shell execution, log parsing, config editing. Agents that operate infrastructure need the same sandboxed computer access.",
  },
  {
    icon: "🔍",
    title: "Research & knowledge work",
    prompt: "Read every doc in /specs, then write a summary with citations",
    description:
      "Fetch URLs, grep through documents, compile findings. Any agent that reads and writes files fits the model.",
  },
];

const FEATURES = [
  {
    icon: "🔌",
    title: "Seven providers, one interface",
    description:
      "OpenAI, Anthropic, Google Gemini, OpenRouter, AWS Bedrock, Vertex AI, and Ollama. Same streaming interface, same tool dispatch. Switch models without changing your code.",
  },
  {
    icon: "💻",
    title: "Five sandbox backends",
    description:
      "LocalSandbox (OS-level), UnsandboxedLocal, sprites.dev, Docker, or E2B cloud. Swap one line to change the isolation boundary — from raw host access to a remote container.",
  },
  {
    icon: "🛠️",
    title: "Nine built-in tools",
    description:
      "ReadFile, WriteFile, EditFile, Bash, Glob, Grep, WebFetch, NotebookEdit, AskUser — the same tools shipping inside production coding agents, wired up and ready to go.",
  },
  {
    icon: "💾",
    title: "Resume, compact, persist",
    description:
      "Conversations save as JSONL. Auto-compaction, microcompact, and reactive strategies keep context under control. Resume any thread by ID.",
  },
  {
    icon: "🤖",
    title: "Multi-agent and subagents",
    description:
      "Spawn isolated subagents for focused subtasks. Run a swarm of agents in parallel with message passing and configurable concurrency.",
  },
  {
    icon: "🔗",
    title: "MCP, LSP, ACP, A2A",
    description:
      "Connect to MCP servers for external tools. Query language servers via LSP. Expose your agent over HTTP/WebSocket, or use ACP and A2A protocol adapters.",
  },
  {
    icon: "🔒",
    title: "Permissions and safety",
    description:
      "Six permission modes from full auto to plan-only. Per-tool rules, denial tracking, and an optional AI classifier. Git safety guards built in.",
  },
  {
    icon: "🧠",
    title: "Thinking, structured output",
    description:
      "Unified extended-thinking config across providers. Request JSON output with schema validation. One option, any model.",
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
      "Built-in token usage and USD cost tracking with per-model pricing. OpenTelemetry tracing. Retry with exponential backoff and model fallback.",
  },
  {
    icon: "🪝",
    title: "18 hook events",
    description:
      "Intercept tool calls, session lifecycle, permissions, file writes, model switches, retry, compaction, and memory. Modify inputs, deny actions, or run side effects.",
  },
  {
    icon: "📦",
    title: "Embed anywhere, or use the CLI",
    description:
      "In-process async iterators, HTTP/SSE, WebSocket, Next.js, Electron, VS Code — or just run npx noumen from the terminal. Presets for zero-config setup.",
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
              <span>⚡</span> agent runtime
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

            <TerminalBlock command="npm install noumen" className="max-w-lg" />

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
            Everything between the LLM and the computer
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-center text-[var(--color-text-secondary)]">
            Other SDKs lock you to one model or make you build the tools
            yourself. Noumen ships the full stack &mdash; any provider,
            any sandbox, every tool &mdash; so you ship the agent.
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

      {/* ── Use cases ── */}
      <section className="relative py-24 sm:py-32">
        <div className="relative mx-auto max-w-6xl px-6">
          <h2 className="font-[family-name:var(--font-display)] text-center text-3xl font-bold tracking-tight text-[var(--color-text-primary)] sm:text-4xl">
            Built for coding.{" "}
            <span className="bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] bg-clip-text text-transparent">
              Ready for anything.
            </span>
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-center text-[var(--color-text-secondary)]">
            The same primitives that power coding agents &mdash; filesystem,
            shell, sandboxing, context management &mdash; work for any agent
            that uses a computer.
          </p>

          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {USE_CASES.map((uc) => (
              <div
                key={uc.title}
                className="group flex flex-col gap-4 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-base-card)] p-6 transition hover:border-[var(--color-accent-cyan)] hover:-translate-y-1 hover:shadow-lg hover:shadow-[var(--color-accent-cyan-dim)]"
              >
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{uc.icon}</span>
                  <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                    {uc.title}
                  </h3>
                </div>
                <code className="block rounded-md bg-[var(--color-base-surface)] px-3 py-2 text-xs text-[var(--color-accent-blue)] leading-relaxed">
                  agent.run(&quot;{uc.prompt}&quot;)
                </code>
                <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
                  {uc.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Try it now ── */}
      <section className="relative overflow-hidden py-24 sm:py-32">
        <div className="absolute inset-0 bg-[var(--color-base-surface)]" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[var(--color-accent-blue-dim)] via-transparent to-[var(--color-accent-cyan-dim)] opacity-40" />
        <div className="relative mx-auto max-w-6xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight sm:text-4xl bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] bg-clip-text text-transparent">
              Try it now.
            </h2>
            <p className="mt-4 text-[var(--color-text-secondary)]">
              <code className="rounded bg-[var(--color-base-card)] px-1.5 py-0.5 font-mono text-sm text-[var(--color-text-primary)]">npx noumen</code>{" "}
              starts an interactive coding agent in your terminal.
              No config, no signup. One prompt and it reads files, edits code,
              runs tests, and reports back.
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
          <div className="mb-4 text-5xl">⚡</div>
          <h2 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight text-[var(--color-text-primary)] sm:text-4xl">
            Three imports to a{" "}
            <span className="bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-cyan)] bg-clip-text text-transparent">
              coding agent.
            </span>
          </h2>
          <div className="mt-8 space-y-2 text-left">
            <TerminalBlock command="npm install noumen" />
            <TerminalBlock command='import { Agent } from "noumen"' />
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
