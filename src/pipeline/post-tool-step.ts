import type { ChatMessage, ToolCallContent, StreamEvent } from "../session/types.js";
import type { OutputFormat } from "../providers/types.js";
import type { HookDefinition } from "../hooks/types.js";
import type { SkillDefinition } from "../skills/types.js";
import type { ContextFile } from "../context/types.js";
import type { ChatCompletionUsage } from "../providers/types.js";
import { activateSkillsForPaths } from "../skills/activation.js";
import { activateContextForPaths } from "../context/loader.js";
import { runNotificationHooks } from "../hooks/runner.js";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "../tools/structured-output.js";
import type { ContentReplacementRecord } from "../session/types.js";
import { SessionStorage } from "../session/storage.js";

export interface PostToolStepParams {
  touchedFilePaths: string[];
  toolCalls: ToolCallContent[];
  spilledRecords: ContentReplacementRecord[];
  signal: AbortSignal;
  sessionId: string;
  storage: SessionStorage;
  messages: ChatMessage[];
  hooks: HookDefinition[];
  allSkills: SkillDefinition[];
  activatedSkills: Set<string>;
  projectContext?: ContextFile[];
  activatedContextRules: Set<string>;
  cwd: string;
  isFinalResponseMode: boolean;
  outputFormat?: OutputFormat;
  maxTurns?: number;
  callCount: number;
  preventContinuation: boolean;
  turnUsage: ChatCompletionUsage;
  model: string;
  toolSearchEnabled: boolean;
  getActiveToolDefinitions: () => import("../providers/types.js").ToolDefinition[];
  buildSystemPrompt: () => Promise<string>;
}

export interface PostToolStepResult {
  events: StreamEvent[];
  preventContinuation: boolean;
  shouldBreak: boolean;
  shouldContinue: boolean;
  systemPrompt?: string;
  toolDefs?: import("../providers/types.js").ToolDefinition[];
  hasAttemptedReactiveCompactReset: boolean;
}

export async function postToolStep(
  params: PostToolStepParams,
): Promise<PostToolStepResult> {
  const {
    touchedFilePaths,
    toolCalls,
    spilledRecords,
    signal,
    sessionId,
    storage,
    messages,
    hooks,
    allSkills,
    activatedSkills,
    projectContext,
    activatedContextRules,
    cwd,
    isFinalResponseMode,
    outputFormat,
    maxTurns,
    callCount,
    turnUsage,
    model,
    toolSearchEnabled,
    getActiveToolDefinitions,
    buildSystemPrompt,
  } = params;

  let { preventContinuation } = params;
  const events: StreamEvent[] = [];

  if (spilledRecords.length > 0) {
    await storage.appendContentReplacement(sessionId, spilledRecords);
  }

  if (signal.aborted) {
    const interruptionMsg: ChatMessage = {
      role: "user",
      content: "[Session interrupted by user. Continue from where you left off if resumed.]",
    };
    messages.push(interruptionMsg);
    await storage.appendMessage(sessionId, interruptionMsg).catch(() => {});
    return { events, preventContinuation, shouldBreak: true, shouldContinue: false, hasAttemptedReactiveCompactReset: false };
  }

  let systemPrompt: string | undefined;
  let toolDefs: import("../providers/types.js").ToolDefinition[] | undefined;

  if (touchedFilePaths.length > 0) {
    let needsRebuild = false;

    if (allSkills.length > 0) {
      const newlyActivated = activateSkillsForPaths(
        allSkills,
        touchedFilePaths,
        cwd,
        activatedSkills,
      );
      if (newlyActivated.length > 0) needsRebuild = true;
    }

    if (projectContext?.length) {
      const newCtx = activateContextForPaths(
        projectContext,
        touchedFilePaths,
        cwd,
        activatedContextRules,
      );
      if (newCtx.length > 0) needsRebuild = true;
    }

    if (needsRebuild) {
      systemPrompt = await buildSystemPrompt();
    }
  }

  if (toolSearchEnabled) {
    toolDefs = getActiveToolDefinitions();
  }

  if (isFinalResponseMode) {
    for (const tc of toolCalls) {
      if (tc.function.name === STRUCTURED_OUTPUT_TOOL_NAME) {
        try {
          const parsed = JSON.parse(tc.function.arguments);
          events.push({
            type: "structured_output",
            data: parsed.data ?? parsed,
            schema: outputFormat!,
          });
        } catch {
          events.push({
            type: "structured_output",
            data: tc.function.arguments,
            schema: outputFormat!,
          });
        }
        preventContinuation = true;
        break;
      }
    }
  }

  if (preventContinuation) {
    await runNotificationHooks(hooks, "TurnEnd", { event: "TurnEnd", sessionId });
    events.push({
      type: "turn_complete",
      usage: turnUsage,
      model,
      callCount,
    });
    return { events, preventContinuation, shouldBreak: true, shouldContinue: false, hasAttemptedReactiveCompactReset: false, systemPrompt, toolDefs };
  }

  if (maxTurns !== undefined && callCount >= maxTurns) {
    await runNotificationHooks(hooks, "TurnEnd", { event: "TurnEnd", sessionId });
    events.push({
      type: "turn_complete",
      usage: turnUsage,
      model,
      callCount,
    });
    events.push({ type: "max_turns_reached", maxTurns, turnCount: callCount });
    return { events, preventContinuation, shouldBreak: true, shouldContinue: false, hasAttemptedReactiveCompactReset: false, systemPrompt, toolDefs };
  }

  await runNotificationHooks(hooks, "TurnEnd", { event: "TurnEnd", sessionId });
  return {
    events,
    preventContinuation,
    shouldBreak: false,
    shouldContinue: true,
    hasAttemptedReactiveCompactReset: true,
    systemPrompt,
    toolDefs,
  };
}
