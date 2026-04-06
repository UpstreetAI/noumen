/**
 * Unified tool execution pipeline.
 *
 * Consolidates the full tool call lifecycle — Zod validation, permission
 * resolution, denial tracking, pre/post hooks, execution, and tracing —
 * into a single function. Both the batched and streaming execution paths
 * in `thread.ts` delegate here instead of duplicating the logic.
 */

import type { ToolCallContent, StreamEvent } from "../session/types.js";
import type { ToolResult, ToolContext } from "./types.js";
import type {
  PermissionContext,
  PermissionHandler,
  PermissionRequest,
} from "../permissions/types.js";
import type { HookDefinition } from "../hooks/types.js";
import type { Tracer, Span } from "../tracing/types.js";
import { SpanStatusCode } from "../tracing/types.js";
import type { DenialTracker } from "../permissions/denial-tracking.js";
import type { ToolRegistry } from "./registry.js";
import { resolveToolFlag } from "./registry.js";
import { resolvePermission, type ResolvePermissionOptions } from "../permissions/pipeline.js";
import { isPathInWorkingDirectories } from "../permissions/rules.js";
import {
  runPreToolUseHooks,
  runPostToolUseHooks,
  runPostToolUseFailureHooks,
  runNotificationHooks,
} from "../hooks/runner.js";
import { contentToString } from "../utils/content.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolExecutionContext {
  registry: ToolRegistry;
  toolCtx: ToolContext;
  permCtx: PermissionContext | null;
  permHandler: PermissionHandler | null;
  denialTracker: DenialTracker | null;
  hooks: HookDefinition[];
  sessionId: string;
  tracer: Tracer;
  parentSpan?: Span;
  buildPermissionOpts: () => ResolvePermissionOptions | undefined;
}

export interface ToolExecutionResult {
  toolCall: ToolCallContent;
  parsedArgs: Record<string, unknown>;
  result: ToolResult;
  permissionDenied?: boolean;
  preventContinuation?: boolean;
  events: StreamEvent[];
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function executeToolCall(
  tc: ToolCallContent,
  parsedArgs: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const {
    registry,
    toolCtx,
    permCtx,
    permHandler,
    denialTracker,
    hooks,
    sessionId,
    tracer,
    parentSpan,
    buildPermissionOpts,
  } = ctx;

  let currentArgs = parsedArgs;
  const events: StreamEvent[] = [];
  let preventContinuation = false;

  try {
    // --- 1. Zod validation ---
    const toolDef = registry.get(tc.function.name);
    if (toolDef?.inputSchema) {
      const parsed = toolDef.inputSchema.safeParse(currentArgs);
      if (!parsed.success) {
        const { formatZodValidationError } = await import("../utils/zod.js");
        return {
          toolCall: tc,
          parsedArgs: currentArgs,
          result: {
            content: formatZodValidationError(tc.function.name, parsed.error),
            isError: true,
          },
          events,
        };
      }
      currentArgs = parsed.data as Record<string, unknown>;
    }

    // --- 2. PreToolUse hooks (run before permissions so hooks can modify input / supply decisions) ---
    if (hooks.length > 0) {
      const hookOutput = await runPreToolUseHooks(hooks, {
        event: "PreToolUse",
        toolName: tc.function.name,
        toolInput: currentArgs,
        toolUseId: tc.id,
        sessionId,
      });

      if (hookOutput.decision === "deny") {
        const msg = hookOutput.message ?? "Blocked by hook.";
        return {
          toolCall: tc,
          parsedArgs: currentArgs,
          result: { content: `Hook denied: ${msg}`, isError: true },
          permissionDenied: true,
          events,
        };
      }
      if (hookOutput.updatedInput) {
        currentArgs = hookOutput.updatedInput;

        if (permCtx && permCtx.workingDirectories.length > 0) {
          const hookFilePath =
            typeof currentArgs.file_path === "string"
              ? currentArgs.file_path
              : typeof currentArgs.path === "string"
                ? currentArgs.path
                : undefined;
          if (
            hookFilePath &&
            !isPathInWorkingDirectories(hookFilePath, permCtx.workingDirectories)
          ) {
            return {
              toolCall: tc,
              parsedArgs: currentArgs,
              result: {
                content: `Permission denied: Hook-modified path "${hookFilePath}" is outside working directories.`,
                isError: true,
              },
              permissionDenied: true,
              events,
            };
          }
        }
      }
      if (hookOutput.preventContinuation) {
        preventContinuation = true;
      }
    }

    // --- 3. Permission gate ---
    if (permCtx) {
      const tool = registry.get(tc.function.name);
      if (tool) {
        const decision = await resolvePermission(
          tool,
          currentArgs,
          toolCtx,
          permCtx,
          buildPermissionOpts(),
        );

        if (decision.behavior === "deny") {
          if (decision.reason !== "classifier") {
            denialTracker?.recordDenial();
          }
          events.push({
            type: "permission_denied",
            toolName: tc.function.name,
            input: currentArgs,
            message: decision.message,
          });
          await runNotificationHooks(hooks, "PermissionDenied", {
            event: "PermissionDenied",
            sessionId,
            toolName: tc.function.name,
            input: currentArgs,
            reason: decision.message,
          } as import("../hooks/types.js").PermissionDeniedHookInput);
          if (denialTracker?.shouldFallback().triggered) {
            const state = denialTracker.getState();
            events.push({
              type: "denial_limit_exceeded",
              consecutiveDenials: state.consecutiveDenials,
              totalDenials: state.totalDenials,
            });
            preventContinuation = true;
          }
          return {
            toolCall: tc,
            parsedArgs: currentArgs,
            result: {
              content: `Permission denied: ${decision.message}`,
              isError: true,
            },
            permissionDenied: true,
            preventContinuation: preventContinuation || undefined,
            events,
          };
        }

        if (decision.behavior === "ask") {
          await runNotificationHooks(hooks, "PermissionRequest", {
            event: "PermissionRequest",
            sessionId,
            toolName: tc.function.name,
            input: currentArgs,
            mode: permCtx.mode ?? "default",
          } as import("../hooks/types.js").PermissionRequestHookInput);
          events.push({
            type: "permission_request",
            toolName: tc.function.name,
            input: currentArgs,
            message: decision.message,
          });

          if (permHandler) {
            const isReadOnly = resolveToolFlag(tool.isReadOnly, currentArgs);
            const isDestructive = resolveToolFlag(tool.isDestructive, currentArgs);
            const request: PermissionRequest = {
              toolName: tc.function.name,
              input: currentArgs,
              message: decision.message,
              suggestions: decision.suggestions,
              isReadOnly,
              isDestructive,
            };
            const response = await permHandler(request);

            if (!response.allow) {
              denialTracker?.recordDenial();
              const feedback = response.feedback ?? "User denied permission.";
              events.push({
                type: "permission_denied",
                toolName: tc.function.name,
                input: currentArgs,
                message: feedback,
              });
              await runNotificationHooks(hooks, "PermissionDenied", {
                event: "PermissionDenied",
                sessionId,
                toolName: tc.function.name,
                input: currentArgs,
                reason: feedback,
              } as import("../hooks/types.js").PermissionDeniedHookInput);
              if (denialTracker?.shouldFallback().triggered) {
                const state = denialTracker.getState();
                events.push({
                  type: "denial_limit_exceeded",
                  consecutiveDenials: state.consecutiveDenials,
                  totalDenials: state.totalDenials,
                });
                preventContinuation = true;
              }
              return {
                toolCall: tc,
                parsedArgs: currentArgs,
                result: {
                  content: `Permission denied: ${feedback}`,
                  isError: true,
                },
                permissionDenied: true,
                preventContinuation: preventContinuation || undefined,
                events,
              };
            }

            if (response.updatedInput) {
              currentArgs = response.updatedInput;
            }
            if (response.addRules) {
              permCtx.rules.push(...response.addRules);
            }
          } else {
            denialTracker?.recordDenial();
            events.push({
              type: "permission_denied",
              toolName: tc.function.name,
              input: currentArgs,
              message: "No permission handler configured.",
            });
            await runNotificationHooks(hooks, "PermissionDenied", {
              event: "PermissionDenied",
              sessionId,
              toolName: tc.function.name,
              input: currentArgs,
              reason: "No permission handler configured.",
            } as import("../hooks/types.js").PermissionDeniedHookInput);
            if (denialTracker?.shouldFallback().triggered) {
              const state = denialTracker.getState();
              events.push({
                type: "denial_limit_exceeded",
                consecutiveDenials: state.consecutiveDenials,
                totalDenials: state.totalDenials,
              });
              preventContinuation = true;
            }
            return {
              toolCall: tc,
              parsedArgs: currentArgs,
              result: {
                content: "Permission denied: No permission handler configured.",
                isError: true,
              },
              permissionDenied: true,
              preventContinuation: preventContinuation || undefined,
              events,
            };
          }
        }

        denialTracker?.recordSuccess();
        if (decision.behavior === "allow" && decision.updatedInput) {
          currentArgs = decision.updatedInput as Record<string, unknown>;
        }
        events.push({
          type: "permission_granted",
          toolName: tc.function.name,
          input: currentArgs,
        });
      }
    }

    // --- 4. Execute ---
    const toolSpan = tracer.startSpan("noumen.tool.execute", {
      parent: parentSpan,
      attributes: { "tool.name": tc.function.name, "tool.id": tc.id },
    });
    let result = await registry.execute(tc.function.name, currentArgs, toolCtx);
    const resultText = contentToString(result.content);
    toolSpan.setStatus(
      result.isError ? SpanStatusCode.ERROR : SpanStatusCode.OK,
      result.isError ? resultText : undefined,
    );
    toolSpan.end();

    // --- 5. PostToolUse hooks ---
    if (hooks.length > 0) {
      const postOutput = await runPostToolUseHooks(hooks, {
        event: "PostToolUse",
        toolName: tc.function.name,
        toolInput: currentArgs,
        toolUseId: tc.id,
        toolOutput: resultText,
        isError: result.isError ?? false,
        sessionId,
      });

      if (postOutput.updatedOutput !== undefined) {
        result = { ...result, content: postOutput.updatedOutput };
      }
      if (postOutput.preventContinuation) {
        preventContinuation = true;
      }

      // --- 6. PostToolUseFailure hooks ---
      if (result.isError) {
        const failOutput = await runPostToolUseFailureHooks(hooks, {
          event: "PostToolUseFailure",
          toolName: tc.function.name,
          toolInput: currentArgs,
          toolUseId: tc.id,
          toolOutput: contentToString(result.content),
          errorMessage: contentToString(result.content),
          sessionId,
        });
        if (failOutput.updatedOutput !== undefined) {
          result = { ...result, content: failOutput.updatedOutput };
        }
        if (failOutput.preventContinuation) {
          preventContinuation = true;
        }
      }
    }

    return {
      toolCall: tc,
      parsedArgs: currentArgs,
      result,
      preventContinuation: preventContinuation || undefined,
      events,
    };
  } catch (execErr) {
    const msg = execErr instanceof Error ? execErr.message : String(execErr);
    const errorResult: ToolResult = { content: `Error executing tool: ${msg}`, isError: true };

    if (hooks.length > 0) {
      try {
        const failOutput = await runPostToolUseFailureHooks(hooks, {
          event: "PostToolUseFailure",
          toolName: tc.function.name,
          toolInput: currentArgs,
          toolUseId: tc.id,
          toolOutput: errorResult.content as string,
          errorMessage: msg,
          sessionId,
        });
        if (failOutput.updatedOutput !== undefined) {
          errorResult.content = failOutput.updatedOutput;
        }
        if (failOutput.preventContinuation) {
          preventContinuation = true;
        }
      } catch {
        // Don't let hook failures mask the original error
      }
    }

    return {
      toolCall: tc,
      parsedArgs: currentArgs,
      result: errorResult,
      preventContinuation: preventContinuation || undefined,
      events,
    };
  }
}
