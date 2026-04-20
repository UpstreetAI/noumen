"use client";

import { useState, useCallback } from "react";

interface AdapterOption {
  id: string;
  name: string;
  code: string;
  importName: string;
  /** Subpath to import from. Defaults to the root barrel `"noumen"`. */
  importPath?: string;
}

interface AdapterRow {
  label: string;
  field: string;
  options: AdapterOption[];
  /** When set, this row is grouped with the previous row sharing the same field. */
  group?: string;
}

const PROVIDERS: AdapterOption[] = [
  {
    id: "openai",
    name: "OpenAI",
    importName: "createOpenAI",
    importPath: "@ai-sdk/openai",
    code: 'new AiSdkProvider({ model: createOpenAI({ apiKey: process.env.OPENAI_API_KEY }).chat("gpt-5") })',
  },
  {
    id: "anthropic",
    name: "Anthropic",
    importName: "createAnthropic",
    importPath: "@ai-sdk/anthropic",
    code: 'new AiSdkProvider({ model: createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })("claude-opus-4.6"), providerFamily: "anthropic", cacheConfig: { enabled: true } })',
  },
  {
    id: "gemini",
    name: "Gemini",
    importName: "createGoogleGenerativeAI",
    importPath: "@ai-sdk/google",
    code: 'new AiSdkProvider({ model: createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY })("gemini-2.5-flash"), providerFamily: "google" })',
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    importName: "createOpenRouter",
    importPath: "@openrouter/ai-sdk-provider",
    code: 'new AiSdkProvider({ model: createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY }).chat("anthropic/claude-opus-4.6") })',
  },
  {
    id: "ollama",
    name: "Ollama",
    importName: "createOllama",
    importPath: "ollama-ai-provider-v2",
    code: 'new AiSdkProvider({ model: createOllama()("qwen2.5-coder:32b") })',
  },
];

const LOCAL_SANDBOXES: AdapterOption[] = [
  {
    id: "local",
    name: "Local",
    importName: "LocalSandbox",
    importPath: "noumen/local",
    code: 'LocalSandbox({ cwd: "/my/project" })',
  },
  {
    id: "unsandboxed",
    name: "Unsandboxed",
    importName: "UnsandboxedLocal",
    importPath: "noumen/unsandboxed",
    code: 'UnsandboxedLocal({ cwd: "/my/project" })',
  },
  {
    id: "docker",
    name: "Docker",
    importName: "DockerSandbox",
    importPath: "noumen/docker",
    code: "DockerSandbox({ container, cwd: \"/workspace\" })",
  },
];

const REMOTE_SANDBOXES: AdapterOption[] = [
  {
    id: "ssh",
    name: "SSH",
    importName: "SshSandbox",
    importPath: "noumen/ssh",
    code: 'SshSandbox({ host: "dev.example.com", cwd: "/workspace" })',
  },
  {
    id: "sprites",
    name: "Sprites",
    importName: "SpritesSandbox",
    importPath: "noumen/sprites",
    code: "SpritesSandbox({ token, spriteName })",
  },
  {
    id: "e2b",
    name: "E2B",
    importName: "E2BSandbox",
    importPath: "noumen/e2b",
    code: "E2BSandbox({ sandbox: e2b, cwd: \"/home/user\" })",
  },
  {
    id: "freestyle",
    name: "Freestyle",
    importName: "FreestyleSandbox",
    importPath: "noumen/freestyle",
    code: 'FreestyleSandbox({ cwd: "/workspace" })',
  },
];

const ROWS: AdapterRow[] = [
  { label: "AI Provider", field: "provider", options: PROVIDERS },
  { label: "Sandbox", field: "sandbox", options: LOCAL_SANDBOXES, group: "Local" },
  { label: "Sandbox", field: "sandbox", options: REMOTE_SANDBOXES, group: "Remote" },
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

/**
 * Deduplicate rows by field — multiple rows with the same field are grouped
 * visually but only one option is active at a time across the group.
 */
const FIELDS = [...new Set(ROWS.map((r) => r.field))];

export function AdapterStack() {
  // Selection state: keyed by field name -> { rowIdx, optIdx }
  const [selected, setSelected] = useState<Record<string, { rowIdx: number; optIdx: number }>>(() => {
    const init: Record<string, { rowIdx: number; optIdx: number }> = {};
    for (const field of FIELDS) {
      const rowIdx = ROWS.findIndex((r) => r.field === field);
      init[field] = { rowIdx, optIdx: 0 };
    }
    return init;
  });

  const handleSelect = useCallback((rowIdx: number, optIdx: number) => {
    const field = ROWS[rowIdx].field;
    setSelected((prev) => ({ ...prev, [field]: { rowIdx, optIdx } }));
  }, []);

  const activeByField = Object.fromEntries(
    FIELDS.map((field) => {
      const sel = selected[field];
      return [field, ROWS[sel.rowIdx].options[sel.optIdx]];
    }),
  );

  const swapKey = FIELDS.map((f) => `${selected[f].rowIdx}-${selected[f].optIdx}`).join("_");

  // Group imports by their path. Root-barrel imports merge with the default
  // `Agent` / `AiSdkProvider` imports; subpath imports emit one `import` line
  // each. `AiSdkProvider` is always imported because every provider option
  // constructs one in the `provider:` slot.
  const BARREL = "noumen";
  const barrelImports = ["Agent", "AiSdkProvider"];
  const subpathImports: { path: string; names: string[] }[] = [];
  for (const f of FIELDS) {
    const opt = activeByField[f];
    const path = opt.importPath ?? BARREL;
    if (path === BARREL) {
      barrelImports.push(opt.importName);
    } else {
      const existing = subpathImports.find((s) => s.path === path);
      if (existing) existing.names.push(opt.importName);
      else subpathImports.push({ path, names: [opt.importName] });
    }
  }

  // Group consecutive rows that share a field into visual blocks
  type RowGroup = { label: string; field: string; icon: React.ReactNode; subgroups: { group?: string; rowIdx: number; options: AdapterOption[] }[] };
  const groups: RowGroup[] = [];
  for (let i = 0; i < ROWS.length; i++) {
    const row = ROWS[i];
    const prev = groups[groups.length - 1];
    if (prev && prev.field === row.field) {
      prev.subgroups.push({ group: row.group, rowIdx: i, options: row.options });
    } else {
      groups.push({
        label: row.label,
        field: row.field,
        icon: ICONS[row.label],
        subgroups: [{ group: row.group, rowIdx: i, options: row.options }],
      });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Adapter rows */}
      <div className="flex flex-col gap-2">
        {groups.map((grp) => (
          <div
            key={grp.field}
            className="flex flex-col gap-1.5 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-base-surface)] px-2.5 py-1.5 sm:flex-row sm:items-start sm:gap-2"
          >
            {grp.subgroups.length <= 1 ? (
              <>
                <div className="flex items-center gap-1.5 text-[var(--color-text-tertiary)] shrink-0 sm:min-w-28 sm:border-r sm:border-[var(--color-border-default)] sm:pr-2">
                  {grp.icon}
                  <span className="text-[10px] font-medium uppercase tracking-wider">
                    {grp.label}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {grp.subgroups[0].options.map((opt, optIdx) => {
                    const sel = selected[grp.field];
                    const isActive = sel.rowIdx === grp.subgroups[0].rowIdx && sel.optIdx === optIdx;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => handleSelect(grp.subgroups[0].rowIdx, optIdx)}
                        className={`cursor-pointer rounded-md px-2 py-1 text-xs font-medium transition-all duration-150 ${
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
              </>
            ) : (
              <>
                <div className="flex flex-col gap-0.5 text-[var(--color-text-tertiary)] shrink-0 sm:min-w-28 sm:border-r sm:border-[var(--color-border-default)] sm:pr-2">
                  <div className="flex items-center gap-1.5">
                    {grp.icon}
                    <span className="text-[10px] font-medium uppercase tracking-wider">
                      {grp.label}
                    </span>
                  </div>
                  <div className="flex gap-2 ml-5">
                    {grp.subgroups.map((sub) => {
                      const sel = selected[grp.field];
                      const isGroupActive = sel.rowIdx === sub.rowIdx;
                      return (
                        <span
                          key={sub.group}
                          className={`text-[9px] uppercase tracking-wider ${isGroupActive ? "opacity-70" : "opacity-30"}`}
                        >
                          {sub.group}
                        </span>
                      );
                    })}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  {grp.subgroups.map((sub) => (
                    <div key={sub.group ?? "default"} className="flex flex-wrap gap-1">
                      {sub.options.map((opt, optIdx) => {
                        const sel = selected[grp.field];
                        const isActive = sel.rowIdx === sub.rowIdx && sel.optIdx === optIdx;
                        return (
                          <button
                            key={opt.id}
                            onClick={() => handleSelect(sub.rowIdx, optIdx)}
                            className={`cursor-pointer rounded-md px-2 py-1 text-xs font-medium transition-all duration-150 ${
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
                  ))}
                </div>
              </>
            )}
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
            {/* Import lines */}
            <span className="text-[var(--color-text-tertiary)]">{"import { "}</span>
            <span key={`barrel-${swapKey}`} className="adapter-swap text-[var(--color-accent-cyan)]">
              {barrelImports.join(", ")}
            </span>
            <span className="text-[var(--color-text-tertiary)]">{' } from "noumen";\n'}</span>
            {subpathImports.map((sub, i) => (
              <span key={`sub-${i}-${swapKey}`}>
                <span className="text-[var(--color-text-tertiary)]">{"import { "}</span>
                <span className="adapter-swap text-[var(--color-accent-cyan)]">
                  {sub.names.join(", ")}
                </span>
                <span className="text-[var(--color-text-tertiary)]">
                  {` } from "${sub.path}";\n`}
                </span>
              </span>
            ))}
            <span className="text-[var(--color-text-tertiary)]">{"\n"}</span>

            {/* Constructor */}
            <span className="text-[var(--color-text-tertiary)]">
              {"const agent = new Agent({\n"}
            </span>
            {FIELDS.map((field) => (
              <span key={field}>
                <span className="text-[var(--color-text-tertiary)]">
                  {"  " + field + ": "}
                </span>
                <span key={`${field}-${swapKey}`} className="adapter-swap text-[var(--color-accent-blue)]">
                  {activeByField[field].code}
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
