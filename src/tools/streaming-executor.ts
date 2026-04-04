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

  constructor(
    private readonly getTool: (name: string) => Tool | undefined,
    private readonly executeFn: StreamingToolExecutorFn,
  ) {}

  addTool(toolCall: ToolCallContent, parsedArgs: Record<string, unknown>): void {
    const toolDef = this.getTool(toolCall.function.name);
    const isConcurrencySafe = toolDef
      ? resolveToolFlag(toolDef.isConcurrencySafe, parsedArgs)
      : false;

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
  }

  /**
   * Synchronously yield any completed results (called during streaming).
   * Preserves declaration order: stops before a non-safe executing tool.
   */
  *getCompletedResults(): Generator<StreamingExecResult, void> {
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
   */
  async *getRemainingResults(): AsyncGenerator<StreamingExecResult, void> {
    while (this.hasUnfinished()) {
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
