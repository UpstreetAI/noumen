import chalk from "chalk";
import * as readline from "node:readline/promises";
import type { StreamEvent } from "../session/types.js";
import type { MergedConfig } from "./config.js";

/**
 * Render a single StreamEvent to the terminal. Handles three modes:
 * - JSONL (--json): one JSON line per event to stdout
 * - Quiet (--quiet): accumulates text, caller prints at end
 * - Pretty (default): colored streaming output
 */
export function renderEvent(
  event: StreamEvent,
  config: MergedConfig,
  state: RenderState,
): void {
  if (config.json) {
    renderJsonl(event);
    return;
  }

  if (config.quiet) {
    if (event.type === "text_delta") {
      state.accumulatedText += event.text;
    }
    return;
  }

  renderPretty(event, config, state);
}

export interface RenderState {
  accumulatedText: string;
  activeTools: Map<string, string>;
}

export function createRenderState(): RenderState {
  return {
    accumulatedText: "",
    activeTools: new Map(),
  };
}

function renderJsonl(event: StreamEvent): void {
  const serializable = { ...event } as Record<string, unknown>;
  if ("error" in event && event.type === "error") {
    serializable.error = {
      message: event.error.message,
      name: event.error.name,
    };
  }
  process.stdout.write(JSON.stringify(serializable) + "\n");
}

function renderPretty(
  event: StreamEvent,
  config: MergedConfig,
  state: RenderState,
): void {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      state.accumulatedText += event.text;
      break;

    case "thinking_delta":
      if (config.verbose) {
        process.stderr.write(chalk.dim.italic(event.text));
      }
      break;

    case "tool_use_start":
      state.activeTools.set(event.toolUseId, event.toolName);
      if (config.verbose) {
        process.stderr.write(
          chalk.dim(`\n  [${event.toolName}] `) + chalk.dim("running..."),
        );
      }
      break;

    case "tool_result": {
      state.activeTools.delete(event.toolUseId);
      if (config.verbose) {
        const preview = truncateResult(
          typeof event.result === "string"
            ? event.result
            : JSON.stringify(event.result),
          120,
        );
        process.stderr.write(
          chalk.dim(`\n  [${event.toolName}] `) +
            chalk.dim(preview) +
            "\n",
        );
      }
      break;
    }

    case "permission_request":
      process.stderr.write(
        "\n" +
          chalk.yellow("  Permission required: ") +
          chalk.white(event.toolName) +
          "\n" +
          chalk.dim("  " + event.message) +
          "\n",
      );
      break;

    case "permission_granted":
      if (config.verbose) {
        process.stderr.write(chalk.green("  ✓ Granted\n"));
      }
      break;

    case "permission_denied":
      process.stderr.write(
        chalk.red("  ✗ Denied: ") + chalk.dim(event.message) + "\n",
      );
      break;

    case "error":
      process.stderr.write(
        chalk.red("\n  Error: ") + event.error.message + "\n",
      );
      break;

    case "compact_start":
      if (config.verbose) {
        process.stderr.write(chalk.dim("\n  Compacting conversation..."));
      }
      break;

    case "compact_complete":
      if (config.verbose) {
        process.stderr.write(chalk.dim(" done\n"));
      }
      break;

    case "cost_update":
      if (config.verbose) {
        const s = event.summary;
        process.stderr.write(
          chalk.dim(
            `\n  Cost: $${s.totalCostUSD.toFixed(4)} ` +
              `(${s.totalInputTokens} in / ${s.totalOutputTokens} out)\n`,
          ),
        );
      }
      break;

    case "retry_attempt":
      process.stderr.write(
        chalk.yellow(
          `\n  Retrying (${event.attempt}/${event.maxRetries}) in ${event.delayMs}ms...\n`,
        ),
      );
      break;

    case "retry_exhausted":
      process.stderr.write(
        chalk.red(`\n  All ${event.attempts} retry attempts failed.\n`),
      );
      break;

    case "subagent_start":
      if (config.verbose) {
        const preview = event.prompt.slice(0, 80);
        process.stderr.write(chalk.dim(`\n  [subagent] ${preview}...\n`));
      }
      break;

    case "subagent_end":
      if (config.verbose) {
        process.stderr.write(chalk.dim("  [subagent] complete\n"));
      }
      break;

    case "session_resumed":
      process.stderr.write(
        chalk.dim(
          `\n  Resumed session ${event.sessionId.slice(0, 8)}... (${event.messageCount} messages)\n`,
        ),
      );
      break;

    case "max_turns_reached":
      process.stderr.write(
        chalk.yellow(
          `\n  Max turns reached (${event.turnCount}/${event.maxTurns})\n`,
        ),
      );
      break;

    case "turn_complete":
      if (state.accumulatedText && !state.accumulatedText.endsWith("\n")) {
        process.stdout.write("\n");
      }
      state.accumulatedText = "";
      break;

    default:
      break;
  }
}

/**
 * Create a permission handler that prompts Y/n in the terminal.
 * Writes to stderr so stdout stays clean for JSONL piping.
 */
export async function promptPermission(
  rl: readline.Interface,
  toolName: string,
  message: string,
): Promise<boolean> {
  const answer = await rl.question(
    chalk.yellow(`  Allow ${toolName}? `) + chalk.dim("[Y/n] "),
  );
  const normalized = answer.trim().toLowerCase();
  return normalized === "" || normalized === "y" || normalized === "yes";
}

function truncateResult(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}
