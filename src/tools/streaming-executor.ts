import type { ToolResult } from "./types.js";
import type { ToolCallContent, StreamEvent } from "../session/types.js";
import { resolveToolFlag } from "./registry.js";
import type { Tool } from "./types.js";

type ToolStatus = "queued" | "executing" | "completed" | "yielded";

interface TrackedTool {
  id: string;
  toolCall: ToolCallContent;
  parsedArgs: Record<string, unknown>;
  status: ToolStatus;
  isConcurrencySafe: boolean;
  result?: ToolResult;
  permissionDenied?: boolean;
  preventContinuation?: boolean;
  promise?: Promise<void>;
  events: StreamEvent[];
  abortController?: AbortController;
}

export interface StreamingExecResult {
  toolCall: ToolCallContent;
  parsedArgs: Record<string, unknown>;
  result: ToolResult;
  permissionDenied?: boolean;
  preventContinuation?: boolean;
  events: StreamEvent[];
}

export type StreamingToolExecutorFn = (
  toolCall: ToolCallContent,
  parsedArgs: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{
  result: ToolResult;
  permissionDenied?: boolean;
  preventContinuation?: boolean;
  events: StreamEvent[];
}>;

const BASH_TOOL_NAME = "Bash";

/**
 * Executes tools as they arrive during model streaming.
 * Concurrency-safe tools run in parallel; unsafe tools wait for all prior
 * executions to finish before starting.
 *
 * Supports abort propagation: a parent signal aborts all tools, and a
 * Bash tool error aborts sibling tools via siblingAbortController.
 */
export class StreamingToolExecutor {
  private tools: TrackedTool[] = [];
  private progressResolve?: () => void;
  private discarded = false;
  private siblingAbortController: AbortController;
  private hasErrored = false;
  private processingQueue = false;

  constructor(
    private readonly getTool: (name: string) => Tool | undefined,
    private readonly executeFn: StreamingToolExecutorFn,
    private readonly parentSignal?: AbortSignal,
  ) {
    this.siblingAbortController = new AbortController();
    if (parentSignal) {
      if (parentSignal.aborted) {
        this.siblingAbortController.abort(parentSignal.reason);
      } else {
        parentSignal.addEventListener("abort", () => {
          this.siblingAbortController.abort(parentSignal.reason);
        }, { once: true });
      }
    }
  }

  discard(): void {
    this.discarded = true;
    this.siblingAbortController.abort("discarded");
    this.progressResolve?.();
  }

  isDiscarded(): boolean {
    return this.discarded;
  }

  addTool(toolCall: ToolCallContent, parsedArgs: Record<string, unknown>): void {
    if (this.discarded) {
      this.tools.push({
        id: toolCall.id,
        toolCall,
        parsedArgs,
        status: "completed",
        isConcurrencySafe: true,
        result: { content: "Error: Executor was discarded", isError: true },
        events: [],
      });
      return;
    }

    const toolDef = this.getTool(toolCall.function.name);

    if (!toolDef) {
      this.tools.push({
        id: toolCall.id,
        toolCall,
        parsedArgs,
        status: "completed",
        isConcurrencySafe: true,
        result: { content: `Error: Unknown tool "${toolCall.function.name}"`, isError: true },
        events: [],
      });
      this.progressResolve?.();
      return;
    }

    let isConcurrencySafe = false;
    try {
      isConcurrencySafe = resolveToolFlag(toolDef.isConcurrencySafe, parsedArgs);
    } catch {
      isConcurrencySafe = false;
    }

    this.tools.push({
      id: toolCall.id,
      toolCall,
      parsedArgs,
      status: "queued",
      isConcurrencySafe,
      events: [],
    });

    void this.processQueue();
  }

  private canExecute(isConcurrencySafe: boolean): boolean {
    const executing = this.tools.filter((t) => t.status === "executing");
    return (
      executing.length === 0 ||
      (isConcurrencySafe && executing.every((t) => t.isConcurrencySafe))
    );
  }

  private async processQueue(): Promise<void> {
    if (this.discarded || this.processingQueue) return;
    this.processingQueue = true;
    try {
      for (const tool of this.tools) {
        if (tool.status !== "queued") continue;

        if (this.canExecute(tool.isConcurrencySafe)) {
          await this.executeTool(tool);
        } else if (!tool.isConcurrencySafe) {
          break;
        }
      }
    } finally {
      this.processingQueue = false;
    }
  }

  private createToolAbortController(): AbortController {
    const toolAc = new AbortController();
    this.siblingAbortController.signal.addEventListener("abort", () => {
      if (!toolAc.signal.aborted) {
        toolAc.abort(this.siblingAbortController.signal.reason);
      }
    }, { once: true });
    if (this.siblingAbortController.signal.aborted) {
      toolAc.abort(this.siblingAbortController.signal.reason);
    }
    return toolAc;
  }

  private async executeTool(tracked: TrackedTool): Promise<void> {
    if (this.discarded || this.siblingAbortController.signal.aborted) {
      tracked.status = "completed";
      tracked.result = { content: "Error: Executor was discarded", isError: true };
      tracked.events = [];
      this.progressResolve?.();
      return;
    }

    tracked.status = "executing";
    const toolAc = this.createToolAbortController();
    tracked.abortController = toolAc;

    tracked.promise = (async () => {
      try {
        const { result, permissionDenied, preventContinuation, events } = await this.executeFn(
          tracked.toolCall,
          tracked.parsedArgs,
          toolAc.signal,
        );
        tracked.result = result;
        tracked.permissionDenied = permissionDenied;
        tracked.preventContinuation = preventContinuation;
        tracked.events = events;

        if (result.isError && tracked.toolCall.function.name === BASH_TOOL_NAME) {
          this.hasErrored = true;
          this.siblingAbortController.abort("sibling_error");
        }
      } catch (err) {
        tracked.result = {
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
        tracked.events = [];
        if (tracked.toolCall.function.name === BASH_TOOL_NAME) {
          this.hasErrored = true;
          this.siblingAbortController.abort("sibling_error");
        }
      }
      tracked.status = "completed";
      this.progressResolve?.();
    })();

    void tracked.promise.finally(() => void this.processQueue());
  }

  *getCompletedResults(): Generator<StreamingExecResult, void> {
    if (this.discarded) return;

    for (const tool of this.tools) {
      if (tool.status === "yielded") continue;

      if (tool.status === "completed" && tool.result) {
        tool.status = "yielded";
        yield {
          toolCall: tool.toolCall,
          parsedArgs: tool.parsedArgs,
          result: tool.result,
          permissionDenied: tool.permissionDenied,
          preventContinuation: tool.preventContinuation,
          events: tool.events,
        };
      } else if (tool.status === "executing" && !tool.isConcurrencySafe) {
        break;
      }
    }
  }

  async *getRemainingResults(): AsyncGenerator<StreamingExecResult, void> {
    if (this.discarded) {
      for (const tool of this.tools) {
        if (tool.status === "yielded") continue;
        if (tool.status === "completed" && tool.result) {
          tool.status = "yielded";
          yield {
            toolCall: tool.toolCall,
            parsedArgs: tool.parsedArgs,
            result: tool.result,
            permissionDenied: tool.permissionDenied,
            preventContinuation: tool.preventContinuation,
            events: tool.events,
          };
          continue;
        }
        tool.status = "yielded";
        yield {
          toolCall: tool.toolCall,
          parsedArgs: tool.parsedArgs,
          result: { content: "Error: Executor was discarded", isError: true },
          events: [],
        };
      }
      return;
    }

    while (this.hasUnfinished()) {
      if (this.discarded) return;

      await this.processQueue();

      for (const result of this.getCompletedResults()) {
        yield result;
      }

      if (this.hasExecuting() && !this.hasCompleted()) {
        const executingPromises = this.tools
          .filter((t) => t.status === "executing" && t.promise)
          .map((t) => t.promise!);

        const progressPromise = new Promise<void>((resolve) => {
          this.progressResolve = resolve;
        });

        if (executingPromises.length > 0) {
          await Promise.race([...executingPromises, progressPromise]);
        }
      }
    }

    for (const result of this.getCompletedResults()) {
      yield result;
    }
  }

  private hasUnfinished(): boolean {
    return this.tools.some(
      (t) => t.status === "queued" || t.status === "executing",
    );
  }

  private hasExecuting(): boolean {
    return this.tools.some((t) => t.status === "executing");
  }

  private hasCompleted(): boolean {
    return this.tools.some(
      (t) => t.status === "completed" && t.result !== undefined,
    );
  }
}
