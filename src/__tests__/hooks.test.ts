import { describe, it, expect, beforeEach } from "vitest";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textResponse,
  toolCallResponse,
} from "./helpers.js";
import { Thread, type ThreadConfig } from "../thread.js";
import type { StreamEvent } from "../session/types.js";
import type { HookDefinition, PreToolUseHookOutput, PostToolUseHookOutput } from "../hooks/types.js";
import { runPreToolUseHooks, runPostToolUseHooks, runNotificationHooks } from "../hooks/runner.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";

// ---------------------------------------------------------------------------
// Hook runner unit tests
// ---------------------------------------------------------------------------
describe("runPreToolUseHooks", () => {
  it("returns empty output when no hooks match", async () => {
    const output = await runPreToolUseHooks([], {
      event: "PreToolUse",
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolUseId: "tc1",
      sessionId: "s1",
    });
    expect(output).toEqual({});
  });

  it("calls matching hooks and merges updatedInput", async () => {
    const hook: HookDefinition = {
      event: "PreToolUse",
      handler: async () => ({
        updatedInput: { command: "echo safe" },
      } as PreToolUseHookOutput),
    };
    const output = await runPreToolUseHooks([hook], {
      event: "PreToolUse",
      toolName: "Bash",
      toolInput: { command: "rm -rf /" },
      toolUseId: "tc1",
      sessionId: "s1",
    });
    expect(output.updatedInput).toEqual({ command: "echo safe" });
  });

  it("short-circuits on deny decision", async () => {
    const callOrder: string[] = [];
    const hooks: HookDefinition[] = [
      {
        event: "PreToolUse",
        handler: async () => {
          callOrder.push("deny");
          return { decision: "deny", message: "blocked" } as PreToolUseHookOutput;
        },
      },
      {
        event: "PreToolUse",
        handler: async () => {
          callOrder.push("second");
          return {};
        },
      },
    ];
    const output = await runPreToolUseHooks(hooks, {
      event: "PreToolUse",
      toolName: "Bash",
      toolInput: {},
      toolUseId: "tc1",
      sessionId: "s1",
    });
    expect(output.decision).toBe("deny");
    expect(callOrder).toEqual(["deny"]);
  });

  it("filters by matcher pattern", async () => {
    const called: string[] = [];
    const hooks: HookDefinition[] = [
      {
        event: "PreToolUse",
        matcher: "Bash",
        handler: async () => { called.push("bash"); return {}; },
      },
      {
        event: "PreToolUse",
        matcher: "Read*",
        handler: async () => { called.push("read"); return {}; },
      },
    ];
    await runPreToolUseHooks(hooks, {
      event: "PreToolUse",
      toolName: "ReadFile",
      toolInput: {},
      toolUseId: "tc1",
      sessionId: "s1",
    });
    expect(called).toEqual(["read"]);
  });
});

describe("runPostToolUseHooks", () => {
  it("allows replacing tool output", async () => {
    const hook: HookDefinition = {
      event: "PostToolUse",
      handler: async () => ({
        updatedOutput: "redacted",
      } as PostToolUseHookOutput),
    };
    const output = await runPostToolUseHooks([hook], {
      event: "PostToolUse",
      toolName: "Bash",
      toolInput: {},
      toolUseId: "tc1",
      toolOutput: "secret data",
      isError: false,
      sessionId: "s1",
    });
    expect(output.updatedOutput).toBe("redacted");
  });
});

describe("runNotificationHooks", () => {
  it("runs hooks without errors even if one throws", async () => {
    const called: string[] = [];
    const hooks: HookDefinition[] = [
      {
        event: "TurnEnd",
        handler: async () => { throw new Error("oops"); },
      },
      {
        event: "TurnEnd",
        handler: async () => { called.push("ok"); },
      },
    ];
    await runNotificationHooks(hooks, "TurnEnd", {
      event: "TurnEnd",
      sessionId: "s1",
    });
    expect(called).toEqual(["ok"]);
  });
});

// ---------------------------------------------------------------------------
// Thread integration with hooks
// ---------------------------------------------------------------------------
describe("Thread hooks integration", () => {
  let fs: MockFs;
  let computer: MockComputer;
  let provider: MockAIProvider;

  beforeEach(() => {
    fs = new MockFs({ "/project/test.txt": "hello" });
    computer = new MockComputer();
    provider = new MockAIProvider();
  });

  async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const e of gen) events.push(e);
    return events;
  }

  it("PreToolUse hook can deny tool execution", async () => {
    const denyHook: HookDefinition = {
      event: "PreToolUse",
      matcher: "Bash",
      handler: async () => ({ decision: "deny", message: "no bash" } as PreToolUseHookOutput),
    };

    provider.addResponse(
      toolCallResponse("tc1", "Bash", { command: "rm -rf /" }),
    );
    provider.addResponse(textResponse("Ok, skipping."));

    const config: ThreadConfig = {
      aiProvider: provider,
      fs,
      computer,
      sessionDir: "/sessions",
      hooks: [denyHook],
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };

    const thread = new Thread(config, { sessionId: "s1" });
    const events = await collectEvents(thread.run("delete stuff"));

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(0);
  });

  it("PreToolUse hook can modify tool input", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const modifyHook: HookDefinition = {
      event: "PreToolUse",
      handler: async (input) => {
        if (input.event === "PreToolUse") {
          return { updatedInput: { file_path: "/project/test.txt" } } as PreToolUseHookOutput;
        }
      },
    };

    provider.addResponse(
      toolCallResponse("tc1", "ReadFile", { file_path: "/wrong/path" }),
    );
    provider.addResponse(textResponse("Got it."));

    const config: ThreadConfig = {
      aiProvider: provider,
      fs,
      computer,
      sessionDir: "/sessions",
      hooks: [modifyHook],
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };

    const thread = new Thread(config, { sessionId: "s1" });
    const events = await collectEvents(thread.run("read"));

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(1);
    if (results[0].type === "tool_result") {
      expect(results[0].result.content).toContain("hello");
    }
  });

  it("PostToolUse hook can replace output", async () => {
    const replaceHook: HookDefinition = {
      event: "PostToolUse",
      handler: async () => ({
        updatedOutput: "[REDACTED]",
      } as PostToolUseHookOutput),
    };

    provider.addResponse(
      toolCallResponse("tc1", "ReadFile", { file_path: "/project/test.txt" }),
    );
    provider.addResponse(textResponse("Done."));

    const config: ThreadConfig = {
      aiProvider: provider,
      fs,
      computer,
      sessionDir: "/sessions",
      hooks: [replaceHook],
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };

    const thread = new Thread(config, { sessionId: "s1" });
    const events = await collectEvents(thread.run("read"));

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(1);
    if (results[0].type === "tool_result") {
      expect(results[0].result.content).toBe("[REDACTED]");
    }
  });

  it("preventContinuation stops the agent loop", async () => {
    const stopHook: HookDefinition = {
      event: "PostToolUse",
      handler: async () => ({ preventContinuation: true } as PostToolUseHookOutput),
    };

    provider.addResponse(
      toolCallResponse("tc1", "ReadFile", { file_path: "/project/test.txt" }),
    );
    // No second response needed since loop should stop

    const config: ThreadConfig = {
      aiProvider: provider,
      fs,
      computer,
      sessionDir: "/sessions",
      hooks: [stopHook],
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };

    const thread = new Thread(config, { sessionId: "s1" });
    const events = await collectEvents(thread.run("read"));

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  });
});
