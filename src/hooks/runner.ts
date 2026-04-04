import type {
  HookEvent,
  HookDefinition,
  HookInput,
  HookOutput,
  PreToolUseHookInput,
  PreToolUseHookOutput,
  PostToolUseHookInput,
  PostToolUseHookOutput,
} from "./types.js";

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
    const output = (await hook.handler(input)) as PreToolUseHookOutput | void;
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
    const output = (await hook.handler(input)) as PostToolUseHookOutput | void;
    if (!output) continue;

    if (output.updatedOutput !== undefined) {
      merged.updatedOutput = output.updatedOutput;
      input = { ...input, toolOutput: output.updatedOutput };
    }
    if (output.preventContinuation !== undefined) {
      merged.preventContinuation = output.preventContinuation;
    }
  }

  return merged;
}

/**
 * Run notification hooks (fire-and-forget, no return value).
 */
export async function runNotificationHooks(
  hooks: HookDefinition[],
  event: HookEvent,
  input: HookInput,
): Promise<void> {
  const matching = getMatchingHooks(hooks, event);
  for (const hook of matching) {
    try {
      await hook.handler(input);
    } catch {
      // notification hooks are best-effort
    }
  }
}
