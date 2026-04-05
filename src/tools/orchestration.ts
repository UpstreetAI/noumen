import type { Tool, ToolResult, ToolContext } from "./types.js";
import type { ToolCallContent } from "../session/types.js";
import { resolveToolFlag } from "./registry.js";
import { all } from "../utils/generators.js";

const DEFAULT_CONCURRENCY_CAP = 10;

export interface ToolCallExecResult {
  toolCall: ToolCallContent;
  parsedArgs: Record<string, unknown>;
  result: ToolResult;
  /** When true, the result came from a permission denial — not actual tool execution */
  permissionDenied?: boolean;
}

export type ToolCallExecutor = (
  toolCall: ToolCallContent,
  parsedArgs: Record<string, unknown>,
) => Promise<ToolCallExecResult>;

interface Batch {
  isConcurrencySafe: boolean;
  items: Array<{ toolCall: ToolCallContent; parsedArgs: Record<string, unknown> }>;
}

/**
 * Partition tool calls into batches: consecutive concurrency-safe tools
 * are grouped together; each non-safe tool gets its own batch.
 */
export function partitionToolCalls(
  toolCalls: ToolCallContent[],
  getTool: (name: string) => Tool | undefined,
): Batch[] {
  return toolCalls.reduce<Batch[]>((batches, tc) => {
    let parsedArgs: Record<string, unknown> = {};
    let jsonMalformed = false;
    try {
      parsedArgs = JSON.parse(tc.function.arguments);
    } catch {
      jsonMalformed = true;
    }

    const tool = getTool(tc.function.name);
    const isConcurrencySafe = jsonMalformed
      ? false
      : tool
        ? resolveToolFlag(tool.isConcurrencySafe, parsedArgs)
        : false;

    const item = { toolCall: tc, parsedArgs };

    if (
      isConcurrencySafe &&
      batches.length > 0 &&
      batches[batches.length - 1].isConcurrencySafe
    ) {
      batches[batches.length - 1].items.push(item);
    } else {
      batches.push({ isConcurrencySafe, items: [item] });
    }
    return batches;
  }, []);
}

/**
 * Execute tool calls with optimal concurrency: safe tools run in parallel,
 * unsafe tools run one at a time.
 */
export async function* runToolsBatched(
  toolCalls: ToolCallContent[],
  getTool: (name: string) => Tool | undefined,
  executor: ToolCallExecutor,
  concurrencyCap = DEFAULT_CONCURRENCY_CAP,
): AsyncGenerator<ToolCallExecResult, void> {
  const batches = partitionToolCalls(toolCalls, getTool);

  for (const batch of batches) {
    if (batch.isConcurrencySafe && batch.items.length > 1) {
      const generators = batch.items.map(({ toolCall, parsedArgs }) =>
        (async function* () {
          try {
            yield await executor(toolCall, parsedArgs);
          } catch (err) {
            yield {
              toolCall,
              parsedArgs,
              result: {
                content: `Error: ${err instanceof Error ? err.message : String(err)}`,
                isError: true,
              },
            } satisfies ToolCallExecResult;
          }
        })(),
      );
      yield* all(generators, concurrencyCap);
    } else {
      for (const { toolCall, parsedArgs } of batch.items) {
        yield await executor(toolCall, parsedArgs);
      }
    }
  }
}
