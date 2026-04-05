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
) => Promise<{
  result: ToolResult;
  permissionDenied?: boolean;
  preventContinuation?: boolean;
  events: StreamEvent[];
}>;

/**
 * Executes tools as they arrive during model streaming.
 * Concurrency-safe tools run in parallel; unsafe tools wait for all prior
 * executions to finish before starting.
 */
export class StreamingToolExecutor {
  private tools: TrackedTool[] = [];
  private progressResolve?: () => void;
  private discarded = false;

  constructor(
    private readonly getTool: (name: string) => Tool | undefined,
    private readonly executeFn: StreamingToolExecutorFn,
  ) {}

  /**
   * Mark this executor as discarded. Queued tools get synthetic errors,
   * in-flight tools are not awaited, and getRemainingResults() returns
   * immediately.
   */
  discard(): void {
    this.discarded = true;
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

    const isConcurrencySafe = resolveToolFlag(toolDef.isConcurrencySafe, parsedArgs);

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
    if (this.discarded) return;

    for (const tool of this.tools) {
      if (tool.status !== "queued") continue;

      if (this.canExecute(tool.isConcurrencySafe)) {
        await this.executeTool(tool);
      } else if (!tool.isConcurrencySafe) {
        break;
      }
    }
  }

  private async executeTool(tracked: TrackedTool): Promise<void> {
    if (this.discarded) {
      tracked.status = "completed";
      tracked.result = { content: "Error: Executor was discarded", isError: true };
      tracked.events = [];
      this.progressResolve?.();
      return;
    }

    tracked.status = "executing";

    tracked.promise = (async () => {
      try {
        const { result, permissionDenied, preventContinuation, events } = await this.executeFn(
          tracked.toolCall,
          tracked.parsedArgs,
        );
        tracked.result = result;
        tracked.permissionDenied = permissionDenied;
        tracked.preventContinuation = preventContinuation;
        tracked.events = events;
      } catch (err) {
        tracked.result = {
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
        tracked.events = [];
      }
      tracked.status = "completed";
      this.progressResolve?.();
    })();

    void tracked.promise.finally(() => void this.processQueue());
  }

  /**
   * Synchronously yield any completed results (called during streaming).
   * Preserves declaration order: stops before a non-safe executing tool.
   */
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

  /**
   * Async drain: waits for all in-flight tools then yields remaining results.
   * If discarded, yields synthetic errors for all non-yielded tools immediately.
   */
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
