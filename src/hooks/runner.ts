import type {
  HookEvent,
  HookDefinition,
  HookInput,
  HookOutput,
  PreToolUseHookInput,
  PreToolUseHookOutput,
  PostToolUseHookInput,
  PostToolUseHookOutput,
  PostToolUseFailureHookInput,
  PostToolUseFailureHookOutput,
} from "./types.js";

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Hook "${label}" timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Match a tool name against an optional glob-like matcher.
 * Supports '*' as a wildcard prefix/suffix (e.g. "mcp__*", "*File").
 */
function matchesPattern(toolName: string, matcher: string): boolean {
  if (matcher === "*") return true;
  if (matcher.endsWith("*")) {
    return toolName.startsWith(matcher.slice(0, -1));
  }
  if (matcher.startsWith("*")) {
    return toolName.endsWith(matcher.slice(1));
  }
  return toolName === matcher;
}

function getMatchingHooks(
  hooks: HookDefinition[],
  event: HookEvent,
  toolName?: string,
): HookDefinition[] {
  return hooks.filter((h) => {
    if (h.event !== event) return false;
    if (h.matcher && toolName) {
      return matchesPattern(toolName, h.matcher);
    }
    return !h.matcher;
  });
}

/**
 * Run pre-tool-use hooks. Returns a merged output where later hooks override
 * earlier ones. A 'deny' decision from any hook short-circuits.
 */
export async function runPreToolUseHooks(
  hooks: HookDefinition[],
  input: PreToolUseHookInput,
): Promise<PreToolUseHookOutput> {
  const matching = getMatchingHooks(hooks, "PreToolUse", input.toolName);
  let merged: PreToolUseHookOutput = {};

  for (const hook of matching) {
    try {
      const label = hook.matcher ?? "PreToolUse";
      const output = (await withTimeout(
        Promise.resolve(hook.handler(input)),
        DEFAULT_HOOK_TIMEOUT_MS,
        label,
      )) as PreToolUseHookOutput | void;
      if (!output) continue;

      if (output.decision === "deny") {
        return output;
      }
      if (output.updatedInput !== undefined) {
        merged.updatedInput = output.updatedInput;
        input = { ...input, toolInput: output.updatedInput };
      }
      if (output.decision !== undefined) merged.decision = output.decision;
      if (output.message !== undefined) merged.message = output.message;
      if (output.preventContinuation !== undefined) {
        merged.preventContinuation = output.preventContinuation;
      }
    } catch (err) {
      if (hook.blocking) {
        return {
          decision: "deny",
          message: `Blocking hook error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      console.warn(`[noumen/hooks] PreToolUse hook failed:`, err instanceof Error ? err.message : err);
    }
  }

  return merged;
}

/**
 * Run post-tool-use hooks. Returns merged output.
 */
export async function runPostToolUseHooks(
  hooks: HookDefinition[],
  input: PostToolUseHookInput,
): Promise<PostToolUseHookOutput> {
  const matching = getMatchingHooks(hooks, "PostToolUse", input.toolName);
  let merged: PostToolUseHookOutput = {};

  for (const hook of matching) {
    try {
      const label = hook.matcher ?? "PostToolUse";
      const output = (await withTimeout(
        Promise.resolve(hook.handler(input)),
        DEFAULT_HOOK_TIMEOUT_MS,
        label,
      )) as PostToolUseHookOutput | void;
      if (!output) continue;

      if (output.updatedOutput !== undefined) {
        merged.updatedOutput = output.updatedOutput;
        input = { ...input, toolOutput: output.updatedOutput };
      }
      if (output.preventContinuation !== undefined) {
        merged.preventContinuation = output.preventContinuation;
      }
    } catch (err) {
      if (hook.blocking) {
        return {
          updatedOutput: `Blocking hook error: ${err instanceof Error ? err.message : String(err)}`,
          preventContinuation: true,
        };
      }
      console.warn(`[noumen/hooks] PostToolUse hook failed:`, err instanceof Error ? err.message : err);
    }
  }

  return merged;
}

/**
 * Run post-tool-use-failure hooks. Same shape as post-tool-use hooks but
 * triggers on the PostToolUseFailure event, fired only when `isError` is true.
 */
export async function runPostToolUseFailureHooks(
  hooks: HookDefinition[],
  input: PostToolUseFailureHookInput,
): Promise<PostToolUseFailureHookOutput> {
  const matching = getMatchingHooks(hooks, "PostToolUseFailure", input.toolName);
  let merged: PostToolUseFailureHookOutput = {};

  for (const hook of matching) {
    try {
      const label = hook.matcher ?? "PostToolUseFailure";
      const output = (await withTimeout(
        Promise.resolve(hook.handler(input)),
        DEFAULT_HOOK_TIMEOUT_MS,
        label,
      )) as PostToolUseFailureHookOutput | void;
      if (!output) continue;

      if (output.updatedOutput !== undefined) {
        merged.updatedOutput = output.updatedOutput;
        input = { ...input, toolOutput: output.updatedOutput };
      }
      if (output.preventContinuation !== undefined) {
        merged.preventContinuation = output.preventContinuation;
      }
    } catch (err) {
      console.warn(`[noumen/hooks] PostToolUseFailure hook failed:`, err instanceof Error ? err.message : err);
    }
  }

  return merged;
}

/**
 * Run notification hooks concurrently (fire-and-forget, no return value).
 */
export async function runNotificationHooks(
  hooks: HookDefinition[],
  event: HookEvent,
  input: HookInput,
): Promise<void> {
  const matching = getMatchingHooks(hooks, event);
  if (matching.length === 0) return;

  const results = await Promise.allSettled(
    matching.map((hook) => {
      const label = hook.matcher ?? String(event);
      return withTimeout(
        Promise.resolve(hook.handler(input)),
        DEFAULT_HOOK_TIMEOUT_MS,
        label,
      );
    }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      const err = result.reason;
      console.warn(`[noumen/hooks] ${event} notification hook failed:`, err instanceof Error ? err.message : err);
    }
  }
}
