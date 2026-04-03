import type { AIProvider, ChatParams } from "../providers/types.js";
import type { ChatMessage } from "../session/types.js";
import type { SessionStorage } from "../session/storage.js";

const COMPACT_SYSTEM_PROMPT = `You are a helpful AI assistant tasked with summarizing conversations. 
Create a concise but comprehensive summary of the conversation so far. 
Preserve all important technical details, decisions made, file paths mentioned, 
code changes discussed, and any pending tasks or context that would be needed 
to continue the conversation effectively.

Format your summary as a structured overview that covers:
1. What was accomplished
2. Key technical details and decisions
3. Current state (what files were modified, what's working/broken)
4. Any pending tasks or next steps discussed`;

export interface CompactOptions {
  customInstructions?: string;
}

export async function compactConversation(
  aiProvider: AIProvider,
  model: string,
  messages: ChatMessage[],
  storage: SessionStorage,
  sessionId: string,
  opts?: CompactOptions,
): Promise<ChatMessage[]> {
  const summaryPrompt =
    opts?.customInstructions ??
    "Please summarize the conversation above concisely but thoroughly.";

  const compactMessages: ChatMessage[] = [
    ...messages,
    { role: "user", content: summaryPrompt },
  ];

  const params: ChatParams = {
    model,
    messages: compactMessages,
    system: COMPACT_SYSTEM_PROMPT,
    max_tokens: 4096,
  };

  let summaryText = "";
  for await (const chunk of aiProvider.chat(params)) {
    for (const choice of chunk.choices) {
      if (choice.delta.content) {
        summaryText += choice.delta.content;
      }
    }
  }

  // Persist the compact boundary and summary
  await storage.appendCompactBoundary(sessionId);
  const summaryMessage: ChatMessage = {
    role: "user",
    content: `[Conversation Summary]\n\n${summaryText}`,
  };
  await storage.appendSummary(sessionId, summaryMessage);

  return [summaryMessage];
}
