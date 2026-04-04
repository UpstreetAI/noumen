import type { AIProvider } from "../providers/types.js";
import type { ChatMessage } from "../session/types.js";
import type { MemoryEntry, MemoryProvider, MemoryType } from "./types.js";
import { buildExtractionPrompt } from "./prompts.js";

const MEMORY_TYPES: ReadonlySet<string> = new Set([
  "user",
  "project",
  "feedback",
  "reference",
]);

interface ExtractionAction {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  action: "create" | "update" | "delete";
  path?: string;
}

interface ExtractionResult {
  memories: ExtractionAction[];
}

export interface ExtractMemoriesResult {
  created: MemoryEntry[];
  updated: MemoryEntry[];
  deleted: string[];
}

/**
 * Summarize the most recent turn of messages into a compact string for the
 * extraction prompt. Keeps the last ~20 messages to avoid sending the entire
 * conversation history to the extraction call.
 */
function summarizeRecentMessages(messages: ChatMessage[], maxMessages = 20): string {
  const recent = messages.slice(-maxMessages);
  const lines: string[] = [];
  for (const msg of recent) {
    const role = msg.role.toUpperCase();
    const text = typeof msg.content === "string"
      ? msg.content
      : "(non-text content)";
    const truncated = text.length > 2000
      ? text.slice(0, 2000) + "…"
      : text;
    lines.push(`[${role}] ${truncated}`);
  }
  return lines.join("\n\n");
}

/**
 * Extract durable memories from a conversation by making a single
 * structured-output LLM call. Applies the returned actions to the
 * `MemoryProvider` and returns a summary of changes.
 */
export async function extractMemories(
  llmProvider: AIProvider,
  model: string,
  messages: ChatMessage[],
  provider: MemoryProvider,
): Promise<ExtractMemoriesResult> {
  const existingIndex = await provider.loadIndex();
  const summary = summarizeRecentMessages(messages);
  const prompt = buildExtractionPrompt(summary, existingIndex);

  const extractionMessages: ChatMessage[] = [
    { role: "user", content: prompt },
  ];

  let responseText = "";
  for await (const chunk of llmProvider.chat({
    model,
    messages: extractionMessages,
    system: "You are a memory extraction assistant. Respond only with valid JSON.",
    max_tokens: 4096,
  })) {
    for (const choice of chunk.choices) {
      if (choice.delta.content) {
        responseText += choice.delta.content;
      }
    }
  }

  const parsed = parseExtractionResponse(responseText);
  if (!parsed || parsed.memories.length === 0) {
    return { created: [], updated: [], deleted: [] };
  }

  const result: ExtractMemoriesResult = {
    created: [],
    updated: [],
    deleted: [],
  };

  for (const action of parsed.memories) {
    if (!MEMORY_TYPES.has(action.type)) continue;

    if (action.action === "delete" && action.path) {
      await provider.removeEntry(action.path);
      result.deleted.push(action.path);
    } else if (action.action === "update" && action.path) {
      const entry: MemoryEntry = {
        name: action.name,
        description: action.description,
        type: action.type,
        content: action.content,
        path: action.path,
        updatedAt: new Date().toISOString(),
      };
      await provider.saveEntry(entry);
      result.updated.push(entry);
    } else if (action.action === "create") {
      const entry: MemoryEntry = {
        name: action.name,
        description: action.description,
        type: action.type,
        content: action.content,
        updatedAt: new Date().toISOString(),
      };
      await provider.saveEntry(entry);
      result.created.push(entry);
    }
  }

  return result;
}

function parseExtractionResponse(text: string): ExtractionResult | null {
  const trimmed = text.trim();

  // Handle markdown code fences
  let jsonStr = trimmed;
  if (jsonStr.startsWith("```")) {
    const firstNewline = jsonStr.indexOf("\n");
    jsonStr = jsonStr.slice(firstNewline + 1);
    const lastFence = jsonStr.lastIndexOf("```");
    if (lastFence !== -1) {
      jsonStr = jsonStr.slice(0, lastFence);
    }
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.memories)
    ) {
      return parsed as ExtractionResult;
    }
    return null;
  } catch {
    return null;
  }
}
