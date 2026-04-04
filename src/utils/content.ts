import type { ContentPart } from "../session/types.js";

/**
 * Normalize content to a uniform ContentPart[] representation.
 * Strings are wrapped as a single TextContent block.
 */
export function normalizeContent(content: string | ContentPart[]): ContentPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
}

/**
 * Extract the text representation of content. Image blocks are omitted;
 * only text parts are concatenated.
 */
export function contentToString(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Returns true if the content contains at least one image block.
 */
export function hasImageContent(content: string | ContentPart[]): boolean {
  if (typeof content === "string") return false;
  return content.some((p) => p.type === "image" || p.type === "image_url");
}

/**
 * Strip image blocks from content, replacing them with a text placeholder.
 * Returns a plain string when the result contains only text.
 */
export function stripImageContent(
  content: string | ContentPart[],
  placeholder = "[image removed]",
): string | ContentPart[] {
  if (typeof content === "string") return content;
  if (!hasImageContent(content)) return content;

  const parts: ContentPart[] = [];
  let imagePlaceholderAdded = false;

  for (const part of content) {
    if (part.type === "image" || part.type === "image_url") {
      if (!imagePlaceholderAdded) {
        parts.push({ type: "text", text: placeholder });
        imagePlaceholderAdded = true;
      }
    } else {
      parts.push(part);
    }
  }

  if (parts.length === 1 && parts[0].type === "text") {
    return parts[0].text;
  }
  return parts;
}
