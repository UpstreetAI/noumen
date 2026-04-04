#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { loadCliConfig, mergeConfig, type MergedConfig } from "./config.js";
import { createProvider, detectProvider } from "./provider-factory.js";
import { startRepl } from "./repl.js";
import { renderEvent, createRenderState, promptPermission } from "./render.js";
import { runInit } from "./init.js";
import { Code, LocalSandbox } from "../index.js";
import type { ThinkingConfig } from "../thinking/types.js";
import type { PermissionMode } from "../permissions/types.js";

const VERSION = "0.1.0";

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
    .option("-p, --provider <name>", "openai | anthropic | gemini | openrouter | bedrock | vertex")
    .option("-m, --model <model>", "model name")
    .option("--api-key <key>", "API key (overrides env vars)")
    .option("--cwd <dir>", "working directory")
    .option("--permission <mode>", "permission mode (default, plan, acceptEdits, auto, bypassPermissions)")
    .option("--thinking <level>", "thinking level: off, low, medium, high")
    .option("--max-turns <n>", "max agent turns", parseInt)
    .option("--json", "emit JSONL stream events to stdout")
    .option("--quiet", "only output final text")
    .option("--verbose", "show tool calls and thinking")
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

  await program.parseAsync(process.argv);
}

async function runAgent(config: MergedConfig): Promise<void> {
  const providerName =
    config.provider ?? detectProvider();

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
      const { SUPPORTED_PROVIDERS } = await import("./provider-factory.js");
      const providerAnswer = await rl.question(
        `  Provider (${SUPPORTED_PROVIDERS.join(", ")}) [${chalk.bold("anthropic")}]: `,
      );
      const picked = providerAnswer.trim() || "anthropic";
      if (!SUPPORTED_PROVIDERS.includes(picked)) {
        process.stderr.write(chalk.red(`Unknown provider: ${picked}\n`));
        process.exit(1);
      }

      const needsKey = !["bedrock", "vertex"].includes(picked);
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

  const provider = await createProvider(providerName, {
    apiKey: config.apiKey,
    model: config.model,
    configApiKey: config.apiKey,
  });

  const thinking = parseThinking(config.thinking);
  const permissionMode = (config.permissions ?? "default") as PermissionMode;

  const code = new Code({
    aiProvider: provider,
    sandbox: LocalSandbox({ cwd: config.cwd }),
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
      sessionDir: config.sessionDir ?? ".noumen/sessions",
      projectContext: true,
      costTracking: { enabled: true },
      retry: true,
    },
  });

  await code.init();

  if (config.prompt) {
    await runOneShot(code, config);
  } else {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        chalk.red("Interactive mode requires a TTY. Use -c or pipe input.\n"),
      );
      process.exit(1);
    }
    await startRepl(code, config);
  }

  await code.close();
}

async function runOneShot(code: Code, config: MergedConfig): Promise<void> {
  const thread = code.createThread();
  const state = createRenderState();
  const runOpts = config.maxTurns ? { maxTurns: config.maxTurns } : undefined;

  for await (const event of thread.run(config.prompt!, runOpts)) {
    renderEvent(event, config, state);
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

  const providerName = merged.provider ?? detectProvider();
  if (!providerName) {
    process.stderr.write(chalk.red("No provider configured. Run `noumen init` first.\n"));
    process.exit(1);
  }

  const provider = await createProvider(providerName, {
    apiKey: merged.apiKey,
    model: merged.model,
    configApiKey: merged.apiKey,
  });

  const code = new Code({
    aiProvider: provider,
    sandbox: LocalSandbox({ cwd }),
    options: { cwd, sessionDir: merged.sessionDir ?? ".noumen/sessions" },
  });

  const sessions = await code.listSessions();
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

  const providerName = merged.provider ?? detectProvider();
  if (!providerName) {
    process.stderr.write(chalk.red("No provider configured. Run `noumen init` first.\n"));
    process.exit(1);
  }

  const provider = await createProvider(providerName, {
    apiKey: merged.apiKey,
    model: merged.model,
    configApiKey: merged.apiKey,
  });

  const thinking = parseThinking(merged.thinking);
  const permissionMode = (merged.permissions ?? "default") as PermissionMode;

  const code = new Code({
    aiProvider: provider,
    sandbox: LocalSandbox({ cwd }),
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
      sessionDir: merged.sessionDir ?? ".noumen/sessions",
      projectContext: true,
      costTracking: { enabled: true },
      retry: true,
    },
  });

  await code.init();

  // Match full session ID from partial prefix
  const sessions = await code.listSessions();
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

  const thread = code.resumeThread(match.sessionId);

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
    await code.close();
  }
}

main().catch((err) => {
  process.stderr.write(chalk.red(`Fatal: ${err.message}\n`));
  process.exit(1);
});
