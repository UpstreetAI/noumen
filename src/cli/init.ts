import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import chalk from "chalk";
import { SUPPORTED_PROVIDERS, DEFAULT_MODELS, isOllamaRunning, ollamaBaseURL } from "./provider-factory.js";
import { loadCliConfig, resolveCliDotDirs } from "./config.js";

const PERMISSION_MODES = ["default", "plan", "acceptEdits", "auto", "bypassPermissions"];

export async function runInit(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write(chalk.bold("noumen init") + "\n\n");

    const provider = await askChoice(
      rl,
      "Provider",
      SUPPORTED_PROVIDERS,
      "anthropic",
    );

    let defaultModel = DEFAULT_MODELS[provider] ?? "";

    if (provider === "ollama") {
      const ollamaModels = await listOllamaModels();
      if (ollamaModels.length > 0) {
        process.stdout.write(chalk.dim(`  Available models: ${ollamaModels.join(", ")}\n`));
        if (ollamaModels.includes(defaultModel)) {
          // keep the default
        } else {
          defaultModel = ollamaModels[0];
        }
      } else {
        process.stdout.write(
          chalk.yellow(
            `\n  Ollama doesn't appear to be running at ${ollamaBaseURL()}.\n` +
            `  Install it from https://ollama.com, then run:\n` +
            `    ollama pull ${defaultModel}\n` +
            `    ollama serve\n\n`,
          ),
        );
      }
    }

    const model = await askDefault(rl, "Model", defaultModel);

    const permissions = await askChoice(
      rl,
      "Permission mode",
      PERMISSION_MODES,
      "default",
    );

    const config: Record<string, unknown> = { provider };
    if (model !== defaultModel) config.model = model;
    if (permissions !== "default") config.permissions = permissions;

    const existing = loadCliConfig(process.cwd());
    const resolver = resolveCliDotDirs(existing);
    const dir = resolver.writePath(process.cwd());
    fs.mkdirSync(dir, { recursive: true });

    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    process.stdout.write(chalk.green(`  Created ${configPath}\n`));

    const noumenMdPath = path.join(process.cwd(), "NOUMEN.md");
    if (!fs.existsSync(noumenMdPath)) {
      const create = await askDefault(rl, "Create NOUMEN.md?", "Y");
      if (create.toLowerCase() === "y" || create.toLowerCase() === "yes") {
        fs.writeFileSync(noumenMdPath, NOUMEN_MD_TEMPLATE);
        process.stdout.write(chalk.green(`  Created ${noumenMdPath}\n`));
      }
    }

    process.stdout.write(
      "\n" + chalk.dim("Run `noumen` to start a session.") + "\n",
    );
  } finally {
    rl.close();
  }
}

async function listOllamaModels(): Promise<string[]> {
  if (!(await isOllamaRunning())) return [];
  try {
    const res = await fetch(`${ollamaBaseURL()}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

async function askChoice(
  rl: readline.Interface,
  label: string,
  choices: string[],
  defaultValue: string,
): Promise<string> {
  const hint = choices.join(", ");
  const answer = await rl.question(
    `  ${label} (${hint}) [${chalk.bold(defaultValue)}]: `,
  );
  const trimmed = answer.trim();
  if (!trimmed) return defaultValue;
  if (choices.includes(trimmed)) return trimmed;
  process.stdout.write(chalk.yellow(`  Invalid choice, using ${defaultValue}\n`));
  return defaultValue;
}

async function askDefault(
  rl: readline.Interface,
  label: string,
  defaultValue: string,
): Promise<string> {
  const answer = await rl.question(
    `  ${label} [${chalk.bold(defaultValue)}]: `,
  );
  return answer.trim() || defaultValue;
}

const NOUMEN_MD_TEMPLATE = `# Project Instructions

Add project-specific instructions for the AI agent here.
These instructions are loaded automatically when running noumen in this directory.

## Guidelines

- Describe your project's coding conventions
- Note important architectural decisions
- List files or patterns the agent should be aware of
`;
