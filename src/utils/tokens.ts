/**
 * Rough token estimation: ~4 chars per token for English text.
 * This avoids pulling in a full tokenizer dependency.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string | unknown }>,
): number {
  let total = 0;
  for (const msg of messages) {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    total += estimateTokens(content) + 4; // 4 tokens overhead per message
  }
  return total;
}
