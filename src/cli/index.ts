#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { loadCliConfig, mergeConfig, type MergedConfig } from "./config.js";
import { createProvider, detectProvider, type ProviderName } from "./provider-factory.js";
import { startRepl } from "./repl.js";
import { renderEvent, createRenderState, promptPermission } from "./render.js";
import { runInit } from "./init.js";
import * as os from "node:os";
import { Agent, LocalSandbox, UnsandboxedLocal, type Sandbox, type DiagnoseResult, type DiagnoseCheckResult } from "../index.js";
import type { ThinkingConfig } from "../thinking/types.js";
import type { PermissionMode } from "../permissions/types.js";

const VERSION = "0.2.0";

async function listLocalOllamaModels(baseURL: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseURL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

function parseThinking(level: string | undefined): ThinkingConfig | undefined {
  if (!level || level === "off") return { type: "disabled" };
  const budgets: Record<string, number> = {
    low: 1024,
    medium: 10240,
    high: 32768,
  };
  const budget = budgets[level];
  if (budget) return { type: "enabled", budgetTokens: budget };
  return undefined;
}

/**
 * Create the CLI sandbox. Defaults to OS-level sandboxed `LocalSandbox`.
 * Use `--no-sandbox` to explicitly opt out.
 */
function createCliSandbox(config: MergedConfig): Sandbox {
  if (config.noSandbox) {
    return UnsandboxedLocal({ cwd: config.cwd });
  }

  const sandboxOpts: import("../index.js").LocalSandboxOptions = {
    cwd: config.cwd,
  };

  const allowWrite = config.sandboxAllowWrite
    ? (config.sandboxAllowWrite as string).split(",").map((s: string) => s.trim())
    : undefined;
  const allowDomains = config.sandboxAllowDomain
    ? (config.sandboxAllowDomain as string).split(",").map((s: string) => s.trim())
    : undefined;

  if (allowWrite || allowDomains) {
    sandboxOpts.sandbox = {
      filesystem: allowWrite ? { allowWrite: [config.cwd, ...allowWrite] } : undefined,
      network: allowDomains ? { allowedDomains: allowDomains } : undefined,
    };
  }

  return LocalSandbox(sandboxOpts);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function main(): Promise<void> {
  const program = new Command("noumen")
    .version(VERSION)
    .description("AI coding agent — bring your own provider")
    .option("-p, --provider <name>", "openai | anthropic | gemini | openrouter | bedrock | vertex | ollama")
    .option("-m, --model <model>", "model name")
    .option("--api-key <key>", "API key (overrides env vars)")
    .option("--base-url <url>", "override provider base URL")
    .option("--cwd <dir>", "working directory")
    .option("--permission <mode>", "permission mode (default, plan, acceptEdits, auto, bypassPermissions, dontAsk)")
    .option("--thinking <level>", "thinking level: off, low, medium, high")
    .option("--max-turns <n>", "max agent turns", parseInt)
    .option("--json", "emit JSONL stream events to stdout")
    .option("--quiet", "only output final text")
    .option("--verbose", "show tool calls and thinking")
    .option("--headless", "NDJSON stdin/stdout protocol for programmatic control")
    .option("--no-sandbox", "disable OS-level sandboxing (use UnsandboxedLocal)")
    .option("--sandbox-allow-write <paths>", "comma-separated paths to allow writing in sandbox")
    .option("--sandbox-allow-domain <domains>", "comma-separated domains to allow in sandbox")
    .option("-c, --prompt <text>", "one-shot prompt (non-interactive)")
    .argument("[prompt...]", "inline prompt")
    .allowExcessArguments(true)
    .action(async (args: string[]) => {
      const opts = program.opts();

      if (args.length > 0 && !opts.prompt) {
        opts.prompt = args.join(" ");
      }

      if (!process.stdin.isTTY && !opts.prompt) {
        opts.prompt = await readStdin();
        if (!opts.prompt) {
          process.stderr.write(chalk.red("No input provided.\n"));
          process.exit(1);
        }
      }

      const cwd = opts.cwd ?? process.cwd();
      const config = loadCliConfig(cwd);
      const merged = mergeConfig(config, opts);

      await runAgent(merged);
    });

  program
    .command("init")
    .description("create .noumen/config.json in the current directory")
    .action(async () => {
      await runInit();
      process.exit(0);
    });

  program
    .command("sessions")
    .description("list past sessions")
    .action(async () => {
      await listSessions();
      process.exit(0);
    });

  program
    .command("resume <session-id>")
    .description("resume a previous session")
    .action(async (sessionId: string) => {
      await resumeSession(sessionId);
    });

  program
    .command("doctor")
    .description("run health checks on provider, sandbox, MCP, and LSP")
    .action(async () => {
      await runDoctor();
    });

  await program.parseAsync(process.argv);
}

async function runAgent(config: MergedConfig): Promise<void> {
  const providerName: ProviderName | undefined =
    (config.provider as ProviderName | undefined) ?? await detectProvider();

  if (!providerName) {
    if (!process.stdin.isTTY) {
      process.stderr.write(chalk.red("No provider specified.\n"));
      process.exit(1);
    }
    process.stderr.write(
      chalk.bold("Welcome to noumen!\n\n") +
        chalk.dim("No provider detected. Let's set one up.\n\n"),
    );

    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });

    try {
      const { SUPPORTED_PROVIDERS, isOllamaRunning, ollamaBaseURL } = await import("./provider-factory.js");
      const providerAnswer = await rl.question(
        `  Provider (${SUPPORTED_PROVIDERS.join(", ")}) [${chalk.bold("ollama")}]: `,
      );
      const picked = providerAnswer.trim() || "ollama";
      if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(picked)) {
        process.stderr.write(chalk.red(`Unknown provider: ${picked}\n`));
        process.exit(1);
      }

      if (picked === "ollama") {
        if (!(await isOllamaRunning())) {
          process.stderr.write(
            chalk.yellow(`\n  Ollama doesn't appear to be running at ${ollamaBaseURL()}.\n`) +
            chalk.yellow(`  Install it from https://ollama.com, then run:\n\n`) +
            `    ${chalk.cyan("ollama pull qwen2.5-coder:32b")}\n` +
            `    ${chalk.cyan("ollama serve")}\n\n` +
            chalk.yellow(`  Then re-run noumen.\n`),
          );
          rl.close();
          process.exit(1);
        }

        const models = await listLocalOllamaModels(ollamaBaseURL());
        if (models.length > 0) {
          process.stderr.write(chalk.dim(`  Available models: ${models.join(", ")}\n`));
          const defaultModel = models.includes("qwen2.5-coder:32b") ? "qwen2.5-coder:32b" : models[0];
          const modelAnswer = await rl.question(
            `  Model [${chalk.bold(defaultModel)}]: `,
          );
          config.model = modelAnswer.trim() || defaultModel;
        }
      }

      const needsKey = !["bedrock", "vertex", "ollama"].includes(picked);
      let apiKey: string | undefined;
      if (needsKey) {
        const keyAnswer = await rl.question(`  API key: `);
        apiKey = keyAnswer.trim();
        if (!apiKey) {
          process.stderr.write(chalk.red("API key is required.\n"));
          process.exit(1);
        }
      }

      rl.close();
      config.provider = picked;
      if (apiKey) config.apiKey = apiKey;
    } catch {
      rl.close();
      process.exit(1);
    }

    return runAgent(config);
  }

  if (!config.model) {
    const { DEFAULT_MODELS } = await import("./provider-factory.js");
    if (providerName === "ollama") {
      const { ollamaBaseURL } = await import("./provider-factory.js");
      const models = await listLocalOllamaModels(ollamaBaseURL());
      const preferred = DEFAULT_MODELS[providerName];
      config.model = models.includes(preferred) ? preferred : models[0] ?? preferred;
    } else {
      config.model = DEFAULT_MODELS[providerName];
    }
  }

  const provider = await createProvider(providerName, {
    apiKey: config.apiKey,
    model: config.model,
    baseURL: config.baseURL,
  });

  const thinking = parseThinking(config.thinking);
  const permissionMode = (config.permissions ?? "default") as PermissionMode;

  const agent = new Agent({
    provider: provider,
    sandbox: createCliSandbox(config),
    options: {
      cwd: config.cwd,
      model: config.model,
      systemPrompt: config.systemPrompt,
      permissions: {
        mode: permissionMode,
      },
      thinking,
      autoCompact: config.autoCompact ?? true,
      enableSubagents: config.enableSubagents ?? true,
      enableTasks: config.enableTasks ?? false,
      enablePlanMode: config.enablePlanMode ?? true,
      enableWorktrees: config.enableWorktrees ?? false,
      mcpServers: config.mcpServers,
      lsp: config.lsp,
      hooks: config.hooks,
      webSearch: config.webSearch,
      ...(config.sessionDir ? { sessionDir: config.sessionDir } : {}),
      ...(config.dotDirs ? { dotDirs: config.dotDirs } : {}),
      projectContext: { cwd: config.cwd, homeDir: os.homedir() },
      costTracking: { enabled: true },
      retry: true,
    },
  });

  if (config.headless) {
    const { runHeadless } = await import("./headless.js");
    await runHeadless(agent, config);
    return;
  }

  await agent.init();

  try {
    if (config.prompt) {
      await runOneShot(agent, config);
    } else {
      if (!process.stdin.isTTY) {
        process.stderr.write(
          chalk.red("Interactive mode requires a TTY. Use -c or pipe input.\n"),
        );
        process.exit(1);
      }
      await startRepl(agent, config, () => agent.close());
    }
  } finally {
    await agent.close();
  }
}

async function runOneShot(agent: Agent, config: MergedConfig): Promise<void> {
  const { startSpinner } = await import("./spinner.js");
  const { isVisibleEvent } = await import("./render.js");
  const thread = await agent.createThread();
  const state = createRenderState();
  const runOpts = config.maxTurns ? { maxTurns: config.maxTurns } : undefined;

  const spinner =
    !config.json && !config.quiet ? startSpinner("Thinking") : null;

  try {
    for await (const event of thread.run(config.prompt!, runOpts)) {
      if (!state.showedActivity && spinner && isVisibleEvent(event, config)) {
        spinner.stop();
        state.showedActivity = true;
      }
      renderEvent(event, config, state);
    }
  } finally {
    spinner?.stop();
  }

  if (config.quiet && state.accumulatedText) {
    process.stdout.write(state.accumulatedText);
    if (!state.accumulatedText.endsWith("\n")) {
      process.stdout.write("\n");
    }
  } else if (state.accumulatedText && !state.accumulatedText.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

async function listSessions(): Promise<void> {
  const cwd = process.cwd();
  const config = loadCliConfig(cwd);
  const merged = mergeConfig(config, { cwd });

  const providerName: ProviderName | undefined = (merged.provider as ProviderName | undefined) ?? await detectProvider();
  if (!providerName) {
    process.stderr.write(chalk.red("No provider configured. Run `noumen init` first.\n"));
    process.exit(1);
  }

  const provider = await createProvider(providerName, {
    apiKey: merged.apiKey,
    model: merged.model,
    baseURL: merged.baseURL,
  });

  const agent = new Agent({
    provider: provider,
    sandbox: UnsandboxedLocal({ cwd }),
    options: {
      cwd,
      ...(merged.sessionDir ? { sessionDir: merged.sessionDir } : {}),
      ...(merged.dotDirs ? { dotDirs: merged.dotDirs } : {}),
    },
  });

  const sessions = await agent.listSessions();
  if (sessions.length === 0) {
    process.stdout.write(chalk.dim("No saved sessions.\n"));
    return;
  }

  process.stdout.write(chalk.bold("Sessions:\n"));
  for (const s of sessions) {
    const title = s.title ? chalk.white(` ${s.title}`) : "";
    process.stdout.write(
      `  ${chalk.cyan(s.sessionId.slice(0, 8))}  ${chalk.dim(s.createdAt)}  ${chalk.dim(`${s.messageCount} msgs`)}${title}\n`,
    );
  }
}

async function resumeSession(sessionId: string): Promise<void> {
  const cwd = process.cwd();
  const config = loadCliConfig(cwd);
  const merged = mergeConfig(config, { cwd });

  const providerName: ProviderName | undefined = (merged.provider as ProviderName | undefined) ?? await detectProvider();
  if (!providerName) {
    process.stderr.write(chalk.red("No provider configured. Run `noumen init` first.\n"));
    process.exit(1);
  }

  const provider = await createProvider(providerName, {
    apiKey: merged.apiKey,
    model: merged.model,
    baseURL: merged.baseURL,
  });

  const thinking = parseThinking(merged.thinking);
  const permissionMode = (merged.permissions ?? "default") as PermissionMode;

  const agent = new Agent({
    provider: provider,
    sandbox: createCliSandbox(merged),
    options: {
      cwd,
      model: merged.model,
      permissions: { mode: permissionMode },
      thinking,
      autoCompact: merged.autoCompact ?? true,
      enableSubagents: merged.enableSubagents ?? true,
      enablePlanMode: merged.enablePlanMode ?? true,
      mcpServers: merged.mcpServers,
      lsp: merged.lsp,
      hooks: merged.hooks,
      ...(merged.sessionDir ? { sessionDir: merged.sessionDir } : {}),
      ...(merged.dotDirs ? { dotDirs: merged.dotDirs } : {}),
      projectContext: { cwd, homeDir: os.homedir() },
      costTracking: { enabled: true },
      retry: true,
    },
  });

  await agent.init();

  // Match full session ID from partial prefix
  const sessions = await agent.listSessions();
  const match = sessions.find(
    (s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId),
  );

  if (!match) {
    process.stderr.write(chalk.red(`Session not found: ${sessionId}\n`));
    process.exit(1);
  }

  process.stderr.write(
    chalk.dim(`Resuming session ${match.sessionId.slice(0, 8)}...\n\n`),
  );

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });

  const thread = await agent.resumeThread(match.sessionId);

  // Enter REPL with the resumed thread
  const { renderEvent: render, createRenderState: makeState } = await import("./render.js");

  process.stderr.write(chalk.dim("Session resumed. Type a message to continue.\n\n"));

  try {
    while (true) {
      let input: string;
      try {
        input = await rl.question(chalk.blue("> "));
      } catch {
        break;
      }
      if (!input.trim()) continue;
      if (input.trim() === "/quit" || input.trim() === "/exit") break;

      const state = makeState();
      for await (const event of thread.run(input)) {
        render(event, merged, state);
      }
      if (state.accumulatedText && !state.accumulatedText.endsWith("\n")) {
        process.stdout.write("\n");
      }
    }
  } finally {
    rl.close();
    await agent.close();
  }
}

async function runDoctor(): Promise<void> {
  const cwd = process.cwd();
  const config = loadCliConfig(cwd);
  const merged = mergeConfig(config, { cwd });

  const providerName: ProviderName | undefined = (merged.provider as ProviderName | undefined) ?? await detectProvider();
  if (!providerName) {
    process.stderr.write(chalk.red("No provider configured. Run `noumen init` first.\n"));
    process.exit(1);
  }

  const provider = await createProvider(providerName, {
    apiKey: merged.apiKey,
    model: merged.model,
    baseURL: merged.baseURL,
  });

  const agent = new Agent({
    provider: provider,
    sandbox: createCliSandbox(merged),
    options: {
      cwd,
      model: merged.model,
      mcpServers: merged.mcpServers,
      lsp: merged.lsp,
      ...(merged.sessionDir ? { sessionDir: merged.sessionDir } : {}),
      ...(merged.dotDirs ? { dotDirs: merged.dotDirs } : {}),
    },
  });

  await agent.init();

  process.stderr.write(chalk.bold("\nnoumen doctor\n\n"));
  const result = await agent.diagnose();
  printDiagnoseResult(result);
  await agent.close();
  process.exit(result.overall ? 0 : 1);
}

function formatCheckLine(label: string, check: DiagnoseCheckResult, extra?: string): string {
  const icon = check.ok ? chalk.green("✓") : chalk.red("✗");
  const timing = check.latencyMs > 0 ? chalk.dim(` (${check.latencyMs}ms)`) : "";
  const suffix = extra ? chalk.dim(` ${extra}`) : "";
  const errMsg = check.error ? chalk.red(`  ${check.error}`) : "";
  const warnMsg = !check.error && check.warning ? chalk.yellow(`  ${check.warning}`) : "";
  return `  ${icon} ${label}${timing}${suffix}${errMsg}${warnMsg}\n`;
}

function printDiagnoseResult(r: DiagnoseResult): void {
  const modelLabel = r.provider.model ? ` (${r.provider.model})` : "";
  process.stderr.write(formatCheckLine(`Provider${modelLabel}`, r.provider));
  process.stderr.write(formatCheckLine("Sandbox: filesystem", r.sandbox.fs));
  process.stderr.write(formatCheckLine("Sandbox: shell", r.sandbox.computer));
  process.stderr.write(formatCheckLine(
    "Sandbox: OS-level (sandbox-runtime)",
    r.sandboxRuntime,
    r.sandboxRuntime.platform,
  ));

  for (const [name, check] of Object.entries(r.mcp)) {
    const parts: string[] = [];
    if (check.status) parts.push(check.status);
    if (check.toolCount != null) parts.push(`${check.toolCount} tools`);
    const extra = parts.length ? parts.join(", ") : undefined;
    process.stderr.write(formatCheckLine(`MCP: ${name}`, check, extra));
  }

  for (const [name, check] of Object.entries(r.lsp)) {
    const extra = check.state ?? undefined;
    process.stderr.write(formatCheckLine(`LSP: ${name}`, check, extra));
  }

  process.stderr.write("\n");
  if (r.overall) {
    process.stderr.write(`  ${chalk.green("Overall: healthy")}\n\n`);
  } else {
    process.stderr.write(`  ${chalk.red("Overall: unhealthy")}\n\n`);
  }
}

main().catch((err) => {
  process.stderr.write(chalk.red(`Fatal: ${err.message}\n`));
  process.exit(1);
});
