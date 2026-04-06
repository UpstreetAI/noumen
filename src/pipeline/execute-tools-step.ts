import type { ChatMessage, ToolCallContent, StreamEvent } from "../session/types.js";
import type { ToolResult } from "../tools/types.js";
import type { ContentReplacementRecord } from "../compact/tool-result-storage.js";
import type { StreamingToolExecutor, StreamingExecResult } from "../tools/streaming-executor.js";
import type { ToolCallExecResult } from "../tools/orchestration.js";
import { runToolsBatched } from "../tools/orchestration.js";
import { executeToolCall, type ToolExecutionContext } from "../tools/execution-pipeline.js";
import type { SessionStorage } from "../session/storage.js";
import type { ToolRegistry } from "../tools/registry.js";

const FILE_TOOLS = new Set(["ReadFile", "WriteFile", "EditFile"]);

export type SpillFn = (
  id: string,
  name: string,
  content: string,
) => Promise<{ content: string; spilled: boolean }>;

export interface ExecuteToolsResult {
  events: StreamEvent[];
  touchedFilePaths: string[];
  preventContinuation: boolean;
  spilledRecords: ContentReplacementRecord[];
}

// ---------------------------------------------------------------------------
// Shared per-result processing
// ---------------------------------------------------------------------------

interface ProcessableResult {
  toolCall: ToolCallContent;
  parsedArgs: Record<string, unknown>;
  result: ToolResult;
  permissionDenied?: boolean;
  preventContinuation?: boolean;
  events?: StreamEvent[];
}

async function processToolResult(
  execResult: ProcessableResult,
  spillFn: SpillFn,
  messages: ChatMessage[],
  recentlyReadFiles: Map<string, string>,
  storage: SessionStorage,
  sessionId: string,
): Promise<{
  events: StreamEvent[];
  touchedPath?: string;
  spillRecord?: ContentReplacementRecord;
  preventContinuation: boolean;
}> {
  const events: StreamEvent[] = [];

  for (const evt of execResult.events ?? []) {
    events.push(evt);
  }

  if (!execResult.permissionDenied) {
    events.push({
      type: "tool_result",
      toolUseId: execResult.toolCall.id,
      toolName: execResult.toolCall.function.name,
      result: execResult.result,
    } as StreamEvent);

    const gitOps = execResult.result.metadata?.gitOperations as
      | Array<{ type: string; details: string }>
      | undefined;
    if (gitOps) {
      for (const op of gitOps) {
        events.push({
          type: "git_operation" as const,
          operation: op.type as "commit" | "push" | "pr_create" | "merge" | "rebase",
          details: op.details,
        } as StreamEvent);
      }
    }
  }

  let resultContent = execResult.result.content;
  let spillRecord: ContentReplacementRecord | undefined;
  if (typeof resultContent === "string") {
    const spill = await spillFn(
      execResult.toolCall.id,
      execResult.toolCall.function.name,
      resultContent,
    );
    if (spill.spilled) {
      resultContent = spill.content;
      spillRecord = { toolUseId: execResult.toolCall.id, replacement: spill.content };
    }
  }

  const toolResultMsg: ChatMessage = {
    role: "tool",
    tool_call_id: execResult.toolCall.id,
    content: resultContent,
    ...(execResult.result.isError ? { isError: true } : {}),
  };
  messages.push(toolResultMsg);
  await storage.appendMessage(sessionId, toolResultMsg);

  let touchedPath: string | undefined;
  if (
    FILE_TOOLS.has(execResult.toolCall.function.name) &&
    typeof execResult.parsedArgs.file_path === "string"
  ) {
    touchedPath = execResult.parsedArgs.file_path;
    if (execResult.toolCall.function.name === "ReadFile" && !execResult.result.isError) {
      const content =
        typeof execResult.result.content === "string" ? execResult.result.content : "";
      recentlyReadFiles.set(execResult.parsedArgs.file_path, content);
    }
  }

  return {
    events,
    touchedPath,
    spillRecord,
    preventContinuation: !!execResult.preventContinuation,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function executeToolsStep(
  toolCalls: ToolCallContent[],
  streamingExec: StreamingToolExecutor | null,
  streamingResults: StreamingExecResult[],
  execCtx: ToolExecutionContext,
  registry: ToolRegistry,
  sessionId: string,
  messages: ChatMessage[],
  recentlyReadFiles: Map<string, string>,
  storage: SessionStorage,
  spillFn: SpillFn,
): Promise<ExecuteToolsResult> {
  const allEvents: StreamEvent[] = [];
  const touchedFilePaths: string[] = [];
  const spilledRecords: ContentReplacementRecord[] = [];
  let preventContinuation = false;

  const handleResult = async (execResult: ProcessableResult) => {
    const processed = await processToolResult(
      execResult,
      spillFn,
      messages,
      recentlyReadFiles,
      storage,
      sessionId,
    );
    allEvents.push(...processed.events);
    if (processed.touchedPath) touchedFilePaths.push(processed.touchedPath);
    if (processed.spillRecord) spilledRecords.push(processed.spillRecord);
    if (processed.preventContinuation) preventContinuation = true;
  };

  if (streamingExec) {
    const allResults = [...streamingResults];
    for await (const result of streamingExec.getRemainingResults()) {
      allResults.push(result);
    }
    for (const execResult of allResults) {
      await handleResult(execResult);
    }
  } else {
    const executor = async (
      tc: ToolCallContent,
      parsedArgs: Record<string, unknown>,
    ): Promise<ToolCallExecResult> => {
      const pipelineResult = await executeToolCall(tc, parsedArgs, execCtx);
      if (pipelineResult.preventContinuation) preventContinuation = true;
      return pipelineResult;
    };

    for await (const execResult of runToolsBatched(
      toolCalls,
      (name) => registry.get(name),
      executor,
    )) {
      await handleResult(execResult);
    }
  }

  return { events: allEvents, touchedFilePaths, preventContinuation, spilledRecords };
}
