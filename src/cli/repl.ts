import * as readline from "node:readline/promises";
import chalk from "chalk";
import type { Agent } from "../agent.js";
import type { Thread } from "../thread.js";
import type { MergedConfig } from "./config.js";
import { renderEvent, createRenderState, promptPermission, isVisibleEvent } from "./render.js";
import { DEFAULT_MODELS, createProvider, SUPPORTED_PROVIDERS, type ProviderName } from "./provider-factory.js";
import { startSpinner } from "./spinner.js";

export async function startRepl(
  code: Agent,
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

  let runningTurn = false;
  let currentThread: Thread = thread;

  const sigintHandler = () => {
    if (runningTurn) {
      currentThread.abort();
      runningTurn = false;
      process.stderr.write(chalk.yellow("\n  Cancelled.\n\n"));
    } else {
      process.stderr.write(chalk.dim("\nGoodbye.\n"));
      rl.close();
      process.exit(0);
    }
  };
  process.on("SIGINT", sigintHandler);

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
        const result = await handleSlashCommand(
          input,
          thread,
          code,
          config,
          rl,
        );
        if (result === "quit") break;
        if (result === "new") {
          thread = code.createThread({
            userInputHandler: (q) => promptPermission(rl, "agent", q).then((ok) => ok ? "yes" : "no"),
          });
          currentThread = thread;
        }
        continue;
      }

      const state = createRenderState();
      const runOpts = config.maxTurns ? { maxTurns: config.maxTurns } : undefined;

      const spinner =
        !config.json && !config.quiet ? startSpinner("Thinking") : null;

      runningTurn = true;
      try {
        for await (const event of thread.run(input, runOpts)) {
          if (!state.showedActivity && spinner && isVisibleEvent(event, config)) {
            spinner.stop();
            state.showedActivity = true;
          }
          renderEvent(event, config, state);
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          // already handled by SIGINT handler
        } else {
          throw err;
        }
      } finally {
        spinner?.stop();
        runningTurn = false;
      }

      if (state.accumulatedText && !state.accumulatedText.endsWith("\n")) {
        process.stdout.write("\n");
      }
    }
  } finally {
    process.removeListener("SIGINT", sigintHandler);
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
      chalk.dim("Type a message to begin. /help for commands, Ctrl+C to cancel.") +
      "\n\n",
  );
}

type SlashResult = "continue" | "quit" | "new";

async function handleSlashCommand(
  input: string,
  thread: Thread,
  code: Agent,
  config: MergedConfig,
  _rl: readline.Interface,
): Promise<SlashResult> {
  const [cmd] = input.trim().split(/\s+/);

  switch (cmd) {
    case "/quit":
    case "/exit":
    case "/q":
      process.stderr.write(chalk.dim("Goodbye.\n"));
      return "quit";

    case "/new":
      process.stderr.write(chalk.dim("Starting new conversation.\n\n"));
      return "new";

    case "/session":
      process.stderr.write(chalk.dim(`Session: ${thread.sessionId}\n`));
      return "continue";

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
      return "continue";
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
      return "continue";
    }

    case "/model": {
      const arg = input.trim().split(/\s+/).slice(1).join(" ");
      if (!arg) {
        process.stderr.write(chalk.dim(`Current model: ${thread.getModel()}\n`));
      } else {
        thread.setModel(arg);
        process.stderr.write(chalk.dim(`Model set to ${arg}\n`));
      }
      return "continue";
    }

    case "/provider": {
      const parts = input.trim().split(/\s+/).slice(1);
      const providerName = parts[0];
      const modelArg = parts[1];
      if (!providerName) {
        process.stderr.write(
          chalk.dim(`Current: ${config.provider ?? "auto"}/${thread.getModel()}\n`) +
          chalk.dim(`Available: ${SUPPORTED_PROVIDERS.join(", ")}\n`),
        );
        return "continue";
      }
      if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(providerName)) {
        process.stderr.write(chalk.red(`Unknown provider: ${providerName}. Available: ${SUPPORTED_PROVIDERS.join(", ")}\n`));
        return "continue";
      }
      try {
        const model = modelArg ?? DEFAULT_MODELS[providerName];
        const provider = await createProvider(providerName as ProviderName, {
          apiKey: config.apiKey,
          model,
          baseURL: config.baseURL,
        });
        thread.setProvider(provider, model);
        config.provider = providerName;
        config.model = model;
        process.stderr.write(chalk.dim(`Switched to ${providerName}/${model}\n`));
      } catch (err) {
        process.stderr.write(chalk.red(`Failed to switch: ${(err as Error).message}\n`));
      }
      return "continue";
    }

    case "/verbose":
      config.verbose = !config.verbose;
      process.stderr.write(
        chalk.dim(`Verbose mode: ${config.verbose ? "on" : "off"}\n`),
      );
      return "continue";

    case "/help":
      process.stderr.write(
        chalk.dim(
          [
            "Commands:",
            "  /quit, /exit        Exit the REPL",
            "  /new                Start a new conversation",
            "  /model [name]       Show or change the model",
            "  /provider [name]    Show or switch provider (and model)",
            "  /session            Show current session ID",
            "  /sessions           List saved sessions",
            "  /cost               Show token usage and cost",
            "  /verbose            Toggle verbose output",
            "  /help               Show this help",
            "",
            "Shortcuts:",
            "  Ctrl+C              Cancel current turn / exit when idle",
            "",
          ].join("\n"),
        ),
      );
      return "continue";

    default:
      process.stderr.write(
        chalk.yellow(`Unknown command: ${cmd}. Try /help\n`),
      );
      return "continue";
  }
}
