import type { VirtualFs, FileEntry, FileStat, ReadOptions } from "../virtual/fs.js";
import type { VirtualComputer, ExecOptions, CommandResult } from "../virtual/computer.js";
import type { AIProvider, ChatParams, ChatStreamChunk, ChatCompletionUsage } from "../providers/types.js";

// ---------------------------------------------------------------------------
// SeededRng — deterministic PRNG for fuzz / property-based tests
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SeededRng {
  private rng: () => number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed;
    this.rng = mulberry32(seed);
  }

  /** Raw float in [0, 1). */
  next(): number {
    return this.rng();
  }

  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.rng() * (max - min + 1));
  }

  /** Pick a random element from a non-empty array. */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.rng() * arr.length)];
  }

  /** Returns true with the given probability (0-1). */
  bool(probability = 0.5): boolean {
    return this.rng() < probability;
  }

  /** Returns `value` with `probability`, otherwise `undefined`. */
  maybe<T>(probability: number, value: T): T | undefined {
    return this.rng() < probability ? value : undefined;
  }

  /** Shuffle an array in place (Fisher-Yates). */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// ---------------------------------------------------------------------------
// MockFs — in-memory VirtualFs backed by a Map<path, content>
// ---------------------------------------------------------------------------

export class MockFs implements VirtualFs {
  files = new Map<string, string>();
  dirs = new Set<string>();
  stats = new Map<string, Partial<FileStat>>();

  constructor(initial?: Record<string, string>) {
    if (initial) {
      for (const [p, c] of Object.entries(initial)) {
        this.files.set(p, c);
        // auto-create parent dirs
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i++) {
          this.dirs.add(parts.slice(0, i).join("/") || "/");
        }
      }
    }
  }

  async readFile(path: string, _opts?: ReadOptions): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      this.dirs.add(parts.slice(0, i).join("/") || "/");
    }
  }

  async appendFile(path: string, content: string): Promise<void> {
    const existing = this.files.get(path) ?? "";
    this.files.set(path, existing + content);
  }

  async deleteFile(path: string, opts?: { recursive?: boolean }): Promise<void> {
    if (opts?.recursive) {
      const prefix = path.endsWith("/") ? path : path + "/";
      for (const key of this.files.keys()) {
        if (key === path || key.startsWith(prefix)) this.files.delete(key);
      }
      this.dirs.delete(path);
    } else {
      this.files.delete(path);
    }
  }

  async mkdir(path: string, _opts?: { recursive?: boolean }): Promise<void> {
    this.dirs.add(path);
  }

  async readdir(path: string, _opts?: { recursive?: boolean }): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    const prefix = path.endsWith("/") ? path : path + "/";

    const seen = new Set<string>();
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const firstSegment = rest.split("/")[0];
      if (seen.has(firstSegment)) continue;
      seen.add(firstSegment);

      const isDir = rest.includes("/");
      entries.push({
        name: firstSegment,
        path: prefix + firstSegment,
        isDirectory: isDir,
        isFile: !isDir,
      });
    }

    // Also include dirs that were explicitly created
    for (const dirPath of this.dirs) {
      if (!dirPath.startsWith(prefix)) continue;
      const rest = dirPath.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      if (seen.has(rest)) continue;
      seen.add(rest);
      entries.push({
        name: rest,
        path: dirPath,
        isDirectory: true,
        isFile: false,
      });
    }

    return entries;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async stat(path: string): Promise<FileStat> {
    const override = this.stats.get(path);
    if (this.files.has(path)) {
      return {
        size: this.files.get(path)!.length,
        isDirectory: false,
        isFile: true,
        ...override,
      };
    }
    if (this.dirs.has(path)) {
      return { size: 0, isDirectory: true, isFile: false, ...override };
    }
    throw new Error(`ENOENT: ${path}`);
  }
}

// ---------------------------------------------------------------------------
// MockComputer — configurable VirtualComputer
// ---------------------------------------------------------------------------

export type CommandHandler = (
  command: string,
  opts?: ExecOptions,
) => CommandResult | Promise<CommandResult>;

export class MockComputer implements VirtualComputer {
  handler: CommandHandler;

  constructor(handler?: CommandHandler) {
    this.handler = handler ?? (() => ({ exitCode: 0, stdout: "", stderr: "" }));
  }

  async executeCommand(command: string, opts?: ExecOptions): Promise<CommandResult> {
    return this.handler(command, opts);
  }
}

// ---------------------------------------------------------------------------
// MockAIProvider — yields pre-configured stream chunk sequences
// ---------------------------------------------------------------------------

export class MockAIProvider implements AIProvider {
  /** Queue of chunk sequences; each call to chat() shifts one off. */
  private responses: ChatStreamChunk[][] = [];
  /** Record of all chat() params received */
  calls: ChatParams[] = [];
  /**
   * Mirrors `AIProvider.defaultModel` so Thread / Agent constructors that
   * require a resolved model don't have to hardcode one in every test.
   */
  defaultModel = "mock-model";

  constructor(responses?: ChatStreamChunk[][]) {
    if (responses) this.responses = [...responses];
  }

  /** Push a response sequence that will be returned by the next chat() call. */
  addResponse(chunks: ChatStreamChunk[]): void {
    this.responses.push(chunks);
  }

  async *chat(params: ChatParams): AsyncIterable<ChatStreamChunk> {
    this.calls.push(params);
    const chunks = this.responses.shift();
    if (!chunks) throw new Error("MockAIProvider: no more responses queued");
    for (const chunk of chunks) {
      yield chunk;
    }
  }
}

// ---------------------------------------------------------------------------
// ErroringAIProvider — yields chunks then throws at a configurable point
// ---------------------------------------------------------------------------

export class ErroringAIProvider implements AIProvider {
  private responses: Array<{ chunks: ChatStreamChunk[]; errorAfter?: number; error?: Error }> = [];
  calls: ChatParams[] = [];

  /**
   * Queue a response that yields `chunks[0..errorAfter-1]` then throws.
   * If `errorAfter` is omitted or >= chunks.length, all chunks yield normally.
   */
  addResponse(
    chunks: ChatStreamChunk[],
    opts?: { errorAfter?: number; error?: Error },
  ): void {
    this.responses.push({
      chunks,
      errorAfter: opts?.errorAfter,
      error: opts?.error,
    });
  }

  async *chat(params: ChatParams): AsyncIterable<ChatStreamChunk> {
    this.calls.push(params);
    const entry = this.responses.shift();
    if (!entry) throw new Error("ErroringAIProvider: no more responses queued");
    const { chunks, errorAfter, error } = entry;
    for (let i = 0; i < chunks.length; i++) {
      if (errorAfter !== undefined && i >= errorAfter) {
        throw error ?? new Error("ErroringAIProvider: simulated stream error");
      }
      yield chunks[i];
    }
  }
}

// ---------------------------------------------------------------------------
// Chunk builder helpers
// ---------------------------------------------------------------------------

let _chunkId = 0;

export function textChunk(text: string): ChatStreamChunk {
  return {
    id: `mock-${_chunkId++}`,
    model: "mock-model",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

export function stopChunk(usage?: ChatCompletionUsage): ChatStreamChunk {
  return {
    id: `mock-${_chunkId++}`,
    model: "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage,
  };
}

export function toolCallStartChunk(
  toolCallId: string,
  toolName: string,
): ChatStreamChunk {
  return {
    id: `mock-${_chunkId++}`,
    model: "mock-model",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: toolCallId,
              type: "function",
              function: { name: toolName, arguments: "" },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

export function toolCallArgChunk(argsFragment: string): ChatStreamChunk {
  return {
    id: `mock-${_chunkId++}`,
    model: "mock-model",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              function: { arguments: argsFragment },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

export function toolCallsFinishChunk(usage?: ChatCompletionUsage): ChatStreamChunk {
  return {
    id: `mock-${_chunkId++}`,
    model: "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage,
  };
}

/**
 * Build a complete text-only response sequence.
 */
export function textResponse(text: string, usage?: ChatCompletionUsage): ChatStreamChunk[] {
  return [textChunk(text), stopChunk(usage)];
}

/**
 * Build a single-tool-call response sequence.
 */
export function toolCallResponse(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  usage?: ChatCompletionUsage,
): ChatStreamChunk[] {
  return [
    toolCallStartChunk(toolCallId, toolName),
    toolCallArgChunk(JSON.stringify(args)),
    toolCallsFinishChunk(usage),
  ];
}

/**
 * Build a multi-tool-call response sequence (parallel tool calls).
 */
export function multiToolCallResponse(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  usage?: ChatCompletionUsage,
): ChatStreamChunk[] {
  const chunks: ChatStreamChunk[] = [];
  for (let i = 0; i < calls.length; i++) {
    const { id, name, args } = calls[i];
    chunks.push({
      id: `mock-${_chunkId++}`,
      model: "mock-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: i,
                id,
                type: "function",
                function: { name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    chunks.push({
      id: `mock-${_chunkId++}`,
      model: "mock-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: i,
                function: { arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  }
  chunks.push(toolCallsFinishChunk(usage));
  return chunks;
}
