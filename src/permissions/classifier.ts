import type { AIProvider, ChatParams } from "../providers/types.js";
import type { ChatMessage } from "../session/types.js";

export interface ClassifierResult {
  shouldBlock: boolean;
  reason: string;
}

const DEFAULT_CLASSIFIER_PROMPT = `You are a security classifier for an AI coding agent. 
Your job is to determine whether a tool call should be automatically approved or blocked.

Automatically APPROVE tool calls that:
- Read files within the project directory
- Write/edit files within the project directory  
- Run common development commands (build, test, lint, format, git status/diff/log)
- Search for files or code patterns
- Create or update task items

Automatically BLOCK tool calls that:
- Execute potentially destructive commands (rm -rf, drop database, force push)
- Access files outside the project directory
- Make network requests to unknown hosts
- Run commands that could affect the system (install packages globally, modify system files)
- Access secrets, credentials, or environment variables

Respond with a JSON object: {"shouldBlock": boolean, "reason": "brief explanation"}`;

/**
 * Run a side-query to classify whether a tool call should be auto-approved.
 */
export async function classifyPermission(
  toolName: string,
  args: Record<string, unknown>,
  recentMessages: ChatMessage[],
  aiProvider: AIProvider,
  opts?: {
    classifierPrompt?: string;
    classifierModel?: string;
    model?: string;
    signal?: AbortSignal;
  },
): Promise<ClassifierResult> {
  const model = opts?.classifierModel ?? opts?.model ?? "gpt-4o-mini";

  const contextWindow = recentMessages.slice(-6);
  const contextText = contextWindow
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content?.slice(0, 200) : ""}`)
    .join("\n");

  const userPrompt =
    `Tool: ${toolName}\n` +
    `Arguments: ${JSON.stringify(args, null, 2).slice(0, 1000)}\n\n` +
    `Recent conversation context:\n${contextText}`;

  const params: ChatParams = {
    model,
    system: opts?.classifierPrompt ?? DEFAULT_CLASSIFIER_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    max_tokens: 256,
    temperature: 0,
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          shouldBlock: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["shouldBlock", "reason"],
        additionalProperties: false,
      },
      name: "classifier_result",
      strict: true,
    },
  };

  try {
    let text = "";
    for await (const chunk of aiProvider.chat(params)) {
      if (opts?.signal?.aborted) break;
      for (const choice of chunk.choices) {
        if (choice.delta.content) {
          text += choice.delta.content;
        }
      }
    }

    const parsed = JSON.parse(text) as ClassifierResult;
    return {
      shouldBlock: parsed.shouldBlock ?? false,
      reason: parsed.reason ?? "unknown",
    };
  } catch {
    // On classifier failure, default to blocking (fail closed)
    return { shouldBlock: true, reason: "Classifier failed; defaulting to block." };
  }
}
