import type { Tool, ToolResult, ToolContext } from "./types.js";
import type { ContentPart } from "../session/types.js";
import { READ_PROMPT } from "./prompts/read.js";
import {
  IMAGE_EXTENSIONS,
  maybeResizeAndDownsampleImageBuffer,
  compressImageBufferWithTokenLimit,
  createImageMetadataText,
} from "../utils/image-resizer.js";
import * as path from "node:path";

const DEFAULT_MAX_IMAGE_TOKENS = 1600;

export const readFileTool: Tool = {
  name: "ReadFile",
  description:
    "Read a file from the filesystem. Returns the file content with line numbers. " +
    "For image files (.png, .jpg, .jpeg, .gif, .webp), returns the image data directly. " +
    "Use offset and limit to read specific portions of large text files.",
  prompt: READ_PROMPT,
  isReadOnly: true,
  isConcurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path of the file to read (absolute or relative to cwd)",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-indexed). Defaults to 1.",
        minimum: 1,
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read. If omitted, reads entire file.",
        minimum: 1,
      },
    },
    required: ["file_path"],
  },

  async call(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const filePath = args.file_path as string;
    const offset = (args.offset as number | undefined) ?? 1;
    const limit = args.limit as number | undefined;

    try {
      // Check if this is an image file
      const ext = path.extname(filePath).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext) && ctx.fs.readFileBytes) {
        return readImageFile(filePath, ext, ctx);
      }

      // Dedup: if cache has same path/offset/limit and mtime is unchanged, skip re-read
      if (ctx.fileStateCache) {
        const cached = ctx.fileStateCache.get(filePath);
        if (
          cached &&
          !cached.isPartialView &&
          cached.offset !== undefined &&
          cached.offset === offset &&
          cached.limit === limit
        ) {
          try {
            const stat = await ctx.fs.stat(filePath);
            const mtime = stat.modifiedAt ? Math.floor(stat.modifiedAt.getTime()) : 0;
            if (mtime === cached.timestamp) {
              return { content: "file_unchanged" };
            }
          } catch {
            // stat failure — proceed with full read
          }
        }
      }

      const content = await ctx.fs.readFile(filePath);
      const lines = content.split("\n");

      const startIdx = Math.max(0, offset - 1);
      const endIdx = limit ? Math.min(lines.length, startIdx + limit) : lines.length;
      const selectedLines = lines.slice(startIdx, endIdx);

      const numbered = selectedLines.map(
        (line, i) => `${String(startIdx + i + 1).padStart(6)}|${line}`,
      );

      let result = numbered.join("\n");
      if (endIdx < lines.length) {
        result += `\n... ${lines.length - endIdx} lines not shown ...`;
      }

      // Record this read in the file state cache
      if (ctx.fileStateCache) {
        let mtime = 0;
        try {
          const stat = await ctx.fs.stat(filePath);
          mtime = stat.modifiedAt ? Math.floor(stat.modifiedAt.getTime()) : 0;
        } catch {
          // If stat fails, use 0 — edits will still require a read
        }
        ctx.fileStateCache.set(filePath, {
          content: selectedLines.join("\n"),
          timestamp: mtime,
          offset,
          limit,
        });
      }

      return { content: result || "File is empty." };
    } catch (err) {
      return {
        content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

async function readImageFile(
  filePath: string,
  ext: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const imageBuffer = await ctx.fs.readFileBytes!(filePath);
  const originalSize = imageBuffer.length;
  const formatExt = ext.replace(/^\./, "");

  const resized = await maybeResizeAndDownsampleImageBuffer(
    imageBuffer,
    originalSize,
    formatExt,
  );

  // Check token budget
  let base64 = resized.buffer.toString("base64");
  let mediaType = resized.mediaType;
  const estimatedTokens = Math.ceil(base64.length * 0.125);

  if (estimatedTokens > DEFAULT_MAX_IMAGE_TOKENS) {
    try {
      const compressed = await compressImageBufferWithTokenLimit(
        imageBuffer,
        DEFAULT_MAX_IMAGE_TOKENS,
        `image/${formatExt}`,
      );
      base64 = compressed.base64;
      mediaType = compressed.mediaType;
    } catch {
      // Use the resized version as-is
    }
  }

  const parts: ContentPart[] = [
    {
      type: "image",
      data: base64,
      media_type: `image/${mediaType}`,
    },
  ];

  if (resized.dimensions) {
    parts.push({
      type: "text",
      text: createImageMetadataText(resized.dimensions),
    });
  }

  return { content: parts };
}
