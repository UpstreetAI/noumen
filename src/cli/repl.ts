import * as readline from "node:readline/promises";
import chalk from "chalk";
import type { Code } from "../code.js";
import type { Thread } from "../thread.js";
import type { MergedConfig } from "./config.js";
import { renderEvent, createRenderState, promptPermission } from "./render.js";
import { DEFAULT_MODELS } from "./provider-factory.js";

export async function startRepl(
  code: Code,
  config: MergedConfig,
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  let thread = code.createThread({
    userInputHandler: (q) => promptPermission(rl, "agent", q).then((ok) => ok ? "yes" : "no"),
  });

  printWelcome(config);

  try {
    while (true) {
      let input: string;
      try {
        input = await rl.question(chalk.blue("> "));
      } catch {
        break;
      }

      if (!input.trim()) continue;

      if (input.startsWith("/")) {
        const shouldContinue = await handleSlashCommand(
          input,
          thread,
          code,
          config,
          rl,
        );
        if (!shouldContinue) break;
        if (input.startsWith("/new")) {
          thread = code.createThread({
            userInputHandler: (q) => promptPermission(rl, "agent", q).then((ok) => ok ? "yes" : "no"),
          });
        }
        continue;
      }

      const state = createRenderState();
      const runOpts = config.maxTurns ? { maxTurns: config.maxTurns } : undefined;

      for await (const event of thread.run(input, runOpts)) {
        renderEvent(event, config, state);
      }

      if (state.accumulatedText && !state.accumulatedText.endsWith("\n")) {
        process.stdout.write("\n");
      }
    }
  } finally {
    rl.close();
  }
}

function printWelcome(config: MergedConfig): void {
  const provider = config.provider ?? "auto";
  const model = config.model ?? DEFAULT_MODELS[provider] ?? "default";
  process.stderr.write(
    chalk.bold("noumen") +
      chalk.dim(` — ${provider}/${model}`) +
      "\n" +
      chalk.dim("Type a message to begin. /help for commands, /quit to exit.") +
      "\n\n",
  );
}

async function handleSlashCommand(
  input: string,
  thread: Thread,
  code: Code,
  config: MergedConfig,
  _rl: readline.Interface,
): Promise<boolean> {
  const [cmd, ...args] = input.trim().split(/\s+/);

  switch (cmd) {
    case "/quit":
    case "/exit":
    case "/q":
      process.stderr.write(chalk.dim("Goodbye.\n"));
      return false;

    case "/new":
      process.stderr.write(chalk.dim("Starting new conversation.\n\n"));
      return true;

    case "/session":
      process.stderr.write(chalk.dim(`Session: ${thread.sessionId}\n`));
      return true;

    case "/cost": {
      const summary = code.getCostSummary();
      if (summary) {
        process.stderr.write(
          chalk.dim(
            `Cost: $${summary.totalCostUSD.toFixed(4)} | ` +
              `Input: ${summary.totalInputTokens} tokens | ` +
              `Output: ${summary.totalOutputTokens} tokens\n`,
          ),
        );
      } else {
        process.stderr.write(chalk.dim("Cost tracking not enabled.\n"));
      }
      return true;
    }

    case "/sessions": {
      const sessions = await code.listSessions();
      if (sessions.length === 0) {
        process.stderr.write(chalk.dim("No saved sessions.\n"));
      } else {
        for (const s of sessions.slice(0, 20)) {
          process.stderr.write(
            chalk.dim(
              `  ${s.sessionId.slice(0, 8)}  ${s.createdAt ?? ""}  ${s.messageCount ?? 0} messages\n`,
            ),
          );
        }
      }
      return true;
    }

    case "/verbose":
      config.verbose = !config.verbose;
      process.stderr.write(
        chalk.dim(`Verbose mode: ${config.verbose ? "on" : "off"}\n`),
      );
      return true;

    case "/help":
      process.stderr.write(
        chalk.dim(
          [
            "Commands:",
            "  /quit, /exit    Exit the REPL",
            "  /new            Start a new conversation",
            "  /session        Show current session ID",
            "  /sessions       List saved sessions",
            "  /cost           Show token usage and cost",
            "  /verbose        Toggle verbose output",
            "  /help           Show this help",
            "",
          ].join("\n"),
        ),
      );
      return true;

    default:
      process.stderr.write(
        chalk.yellow(`Unknown command: ${cmd}. Try /help\n`),
      );
      return true;
  }
}
