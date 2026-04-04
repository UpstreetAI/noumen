"use client";

import { useState, useCallback } from "react";

interface AdapterOption {
  id: string;
  name: string;
  code: string;
  importName: string;
}

interface AdapterRow {
  label: string;
  field: string;
  options: AdapterOption[];
}

const ROWS: AdapterRow[] = [
  {
    label: "AI Provider",
    field: "provider",
    options: [
      {
        id: "openai",
        name: "OpenAI",
        importName: "OpenAIProvider",
        code: "new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY })",
      },
      {
        id: "anthropic",
        name: "Anthropic",
        importName: "AnthropicProvider",
        code: "new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY })",
      },
      {
        id: "gemini",
        name: "Gemini",
        importName: "GeminiProvider",
        code: "new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY })",
      },
      {
        id: "openrouter",
        name: "OpenRouter",
        importName: "OpenRouterProvider",
        code: "new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY })",
      },
    ],
  },
  {
    label: "Sandbox",
    field: "sandbox",
    options: [
      {
        id: "local",
        name: "Local",
        importName: "LocalSandbox",
        code: 'LocalSandbox({ cwd: "/my/project" })',
      },
      {
        id: "sprites",
        name: "Sprites",
        importName: "SpritesSandbox",
        code: "SpritesSandbox({ token, spriteName })",
      },
      {
        id: "docker",
        name: "Docker",
        importName: "DockerSandbox",
        code: "DockerSandbox({ container, cwd: \"/workspace\" })",
      },
      {
        id: "e2b",
        name: "E2B",
        importName: "E2BSandbox",
        code: "E2BSandbox({ sandbox: e2b, cwd: \"/home/user\" })",
      },
    ],
  },
];

const ICONS: Record<string, React.ReactNode> = {
  "AI Provider": (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a8 8 0 0 0-8 8c0 3.4 2.1 6.3 5 7.5V20h6v-2.5c2.9-1.2 5-4.1 5-7.5a8 8 0 0 0-8-8z" />
      <path d="M10 20v2h4v-2" />
    </svg>
  ),
  Sandbox: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <polyline points="8 21 12 17 16 21" />
    </svg>
  ),
};

const STATIC_LINES = [
  "",
  "const thread = agent.createThread();",
  'for await (const event of thread.run("Fix the auth bug")) {',
  "  // ...",
  "}",
];

export function AdapterStack() {
  const [selected, setSelected] = useState([0, 0]);

  const handleSelect = useCallback((rowIdx: number, optIdx: number) => {
    setSelected((prev) => {
      const next = [...prev];
      next[rowIdx] = optIdx;
      return next;
    });
  }, []);

  const activeOptions = ROWS.map((row, i) => row.options[selected[i]]);
  const imports = activeOptions.map((o) => o.importName);
  const swapKey = selected.join("-");

  return (
    <div className="flex flex-col gap-4">
      {/* Adapter rows */}
      <div className="flex flex-col gap-2">
        {ROWS.map((row, rowIdx) => (
            <div
            key={row.field}
            className="flex flex-col gap-2 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-base-surface)] px-3 py-2 sm:flex-row sm:items-center sm:gap-3"
          >
            <div className="flex items-center gap-1.5 text-[var(--color-text-tertiary)] shrink-0">
              {ICONS[row.label]}
              <span className="text-[10px] font-medium uppercase tracking-wider sm:min-w-[5rem]">
                {row.label}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {row.options.map((opt, optIdx) => {
                const isActive = selected[rowIdx] === optIdx;
                return (
                  <button
                    key={opt.id}
                    onClick={() => handleSelect(rowIdx, optIdx)}
                    className={`cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150 ${
                      isActive
                        ? "bg-[var(--color-accent-blue-dim)] text-[var(--color-accent-blue)] border border-[var(--color-accent-blue)]"
                        : "text-[var(--color-text-tertiary)] border border-transparent hover:text-[var(--color-text-secondary)] hover:border-[var(--color-border-default)]"
                    }`}
                  >
                    {opt.name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Live code block */}
      <div className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-base-body)] p-4 font-mono text-[13px] leading-6 shadow-2xl overflow-x-auto">
        <div className="mb-3 flex items-center gap-2">
          <div className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <div className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <div className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
          <span className="ml-2 text-[10px] text-[var(--color-text-tertiary)]">
            index.ts
          </span>
        </div>
        <pre className="whitespace-pre">
          <code>
            {/* Import line */}
            <span className="text-[var(--color-text-tertiary)]">
              {"import { Agent, "}
            </span>
            <span key={`imports-${swapKey}`} className="adapter-swap text-[var(--color-accent-cyan)]">
              {imports.join(", ")}
            </span>
            <span className="text-[var(--color-text-tertiary)]">
              {' } from "noumen";\n\n'}
            </span>

            {/* Constructor */}
            <span className="text-[var(--color-text-tertiary)]">
              {"const agent = new Agent({\n"}
            </span>
            {ROWS.map((row, i) => (
              <span key={row.field}>
                <span className="text-[var(--color-text-tertiary)]">
                  {"  " + row.field + ": "}
                </span>
                <span key={`${row.field}-${selected[i]}`} className="adapter-swap text-[var(--color-accent-blue)]">
                  {activeOptions[i].code}
                </span>
                <span className="text-[var(--color-text-tertiary)]">
                  {",\n"}
                </span>
              </span>
            ))}
            <span className="text-[var(--color-text-tertiary)]">
              {"});\n"}
            </span>

            {/* Static agent loop -- dimmed */}
            {STATIC_LINES.map((line, i) => (
              <span key={i} className="text-[var(--color-text-tertiary)] opacity-50">
                {line + "\n"}
              </span>
            ))}
          </code>
        </pre>
      </div>

      {/* Punchline */}
      <p className="text-center text-xs text-[var(--color-text-tertiary)]">
        The agent loop is identical. Only the adapters change.
      </p>
    </div>
  );
}
