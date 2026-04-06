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
const MAX_FILE_SIZE = 256 * 1024; // 256 KB

const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  "/dev/stdin",
  "/dev/tty",
  "/dev/console",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2",
]);

const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".zip", ".tar", ".gz", ".bz2",
  ".xz", ".7z", ".rar", ".wasm", ".o", ".a", ".obj", ".lib", ".class",
  ".pyc", ".pyo", ".jar", ".war", ".ear", ".iso", ".img", ".dmg",
  ".msi", ".deb", ".rpm", ".apk", ".ipa",
]);

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

    if (filePath.startsWith("\\\\") || filePath.startsWith("//")) {
      return { content: "Error: UNC paths are not allowed", isError: true };
    }

    try {
      // Block device files that can hang or cause OOM
      const resolved = path.resolve(ctx.cwd, filePath);
      if (BLOCKED_DEVICE_PATHS.has(resolved)) {
        return {
          content: `Error: Cannot read device file ${filePath}.`,
          isError: true,
        };
      }
      if (
        resolved.startsWith("/proc/") &&
        (resolved.endsWith("/fd/0") || resolved.endsWith("/fd/1") || resolved.endsWith("/fd/2"))
      ) {
        return {
          content: `Error: Cannot read process file descriptor ${filePath}.`,
          isError: true,
        };
      }

      const ext = path.extname(filePath).toLowerCase();

      // Block binary files (except images, handled below)
      if (BINARY_EXTENSIONS.has(ext)) {
        return {
          content: `Error: Cannot read binary ${ext} file. This tool only reads text files.`,
          isError: true,
        };
      }

      // Check if this is an image file
      if (IMAGE_EXTENSIONS.has(ext) && ctx.fs.readFileBytes) {
        return readImageFile(filePath, ext, ctx);
      }

      // File size guard
      try {
        const stat = await ctx.fs.stat(filePath);
        if (stat.size !== undefined && stat.size > MAX_FILE_SIZE && !limit) {
          return {
            content: `Error: File is too large (${Math.round(stat.size / 1024)}KB, max ${MAX_FILE_SIZE / 1024}KB). Use offset/limit to read specific portions.`,
            isError: true,
          };
        }
      } catch {
        // stat may fail for virtual/remote filesystems — proceed with read
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

      const maxReadBytes = limit
        ? Math.min((limit + (offset - 1)) * 500, 10 * 1024 * 1024)
        : undefined;
      const content = await ctx.fs.readFile(
        filePath,
        maxReadBytes ? { maxBytes: maxReadBytes } : undefined,
      );
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
          isPartialView: !!(limit || offset > 1),
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
