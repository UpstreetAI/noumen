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
import type { HookDefinition } from "../hooks/types.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";
import { agentTool } from "../tools/agent.js";

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("TurnStart hook", () => {
  let fs: MockFs;
  let computer: MockComputer;
  let provider: MockAIProvider;

  beforeEach(() => {
    fs = new MockFs({ "/project/test.txt": "hello" });
    computer = new MockComputer();
    provider = new MockAIProvider();
  });

  it("fires TurnStart before each provider call", async () => {
    const turnStartCalls: string[] = [];

    const hook: HookDefinition = {
      event: "TurnStart",
      handler: async (input) => {
        if (input.event === "TurnStart") {
          turnStartCalls.push(input.sessionId as string);
        }
      },
    };

    provider.addResponse(
      toolCallResponse("tc1", "ReadFile", { file_path: "/project/test.txt" }),
    );
    provider.addResponse(textResponse("done"));

    const config: ThreadConfig = {
      aiProvider: provider,
      fs,
      computer,
      sessionDir: "/sessions",
      hooks: [hook],
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };

    const thread = new Thread(config, { sessionId: "test-session" });
    await collectEvents(thread.run("read the file"));

    expect(turnStartCalls).toEqual(["test-session", "test-session"]);
  });

  it("fires TurnStart once for a single-turn response", async () => {
    let count = 0;
    const hook: HookDefinition = {
      event: "TurnStart",
      handler: async () => { count++; },
    };

    provider.addResponse(textResponse("hello"));

    const config: ThreadConfig = {
      aiProvider: provider,
      fs,
      computer,
      sessionDir: "/sessions",
      hooks: [hook],
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };

    const thread = new Thread(config, { sessionId: "s1" });
    await collectEvents(thread.run("hi"));

    expect(count).toBe(1);
  });
});

describe("TurnEnd hook", () => {
  let fs: MockFs;
  let computer: MockComputer;
  let provider: MockAIProvider;

  beforeEach(() => {
    fs = new MockFs();
    computer = new MockComputer();
    provider = new MockAIProvider();
  });

  it("fires TurnEnd after the agent loop completes", async () => {
    let turnEndSessionId: string | undefined;
    const hook: HookDefinition = {
      event: "TurnEnd",
      handler: async (input) => {
        if (input.event === "TurnEnd") {
          turnEndSessionId = input.sessionId as string;
        }
      },
    };

    provider.addResponse(textResponse("done"));

    const config: ThreadConfig = {
      aiProvider: provider,
      fs,
      computer,
      sessionDir: "/sessions",
      hooks: [hook],
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };

    const thread = new Thread(config, { sessionId: "end-test" });
    await collectEvents(thread.run("hi"));

    expect(turnEndSessionId).toBe("end-test");
  });
});

describe("SubagentStart/SubagentStop hooks", () => {
  let fs: MockFs;
  let computer: MockComputer;

  beforeEach(() => {
    fs = new MockFs();
    computer = new MockComputer();
  });

  it("fires SubagentStart and SubagentStop during Agent tool execution", async () => {
    const hookEvents: Array<{ event: string; sessionId?: string; parentSessionId?: string }> = [];

    const subagentHooks: HookDefinition[] = [
      {
        event: "SubagentStart",
        handler: async (input) => {
          if (input.event === "SubagentStart") {
            hookEvents.push({
              event: "SubagentStart",
              sessionId: input.sessionId as string,
              parentSessionId: input.parentSessionId as string,
            });
          }
        },
      },
      {
        event: "SubagentStop",
        handler: async (input) => {
          if (input.event === "SubagentStop") {
            hookEvents.push({
              event: "SubagentStop",
              sessionId: input.sessionId as string,
              parentSessionId: input.parentSessionId as string,
            });
          }
        },
      },
    ];

    const childProvider = new MockAIProvider();
    childProvider.addResponse(textResponse("subagent result"));

    const parentProvider = new MockAIProvider();
    parentProvider.addResponse(
      toolCallResponse("tc1", "Agent", { prompt: "do something" }),
    );
    parentProvider.addResponse(textResponse("ok done"));

    let childSessionId: string | undefined;

    const config: ThreadConfig = {
      aiProvider: parentProvider,
      fs,
      computer,
      sessionDir: "/sessions",
      hooks: subagentHooks,
      tools: [agentTool],
      spawnSubagent: (subConfig) => {
        const childThread = new Thread(
          {
            aiProvider: childProvider,
            fs,
            computer,
            sessionDir: "/sessions",
            autoCompact: createAutoCompactConfig({ enabled: false }),
          },
          {},
        );
        childSessionId = childThread.sessionId;
        return {
          sessionId: childThread.sessionId,
          events: childThread.run(subConfig.prompt),
        };
      },
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };

    const thread = new Thread(config, { sessionId: "parent-session" });
    await collectEvents(thread.run("spawn an agent"));

    expect(hookEvents).toHaveLength(2);
    expect(hookEvents[0].event).toBe("SubagentStart");
    expect(hookEvents[0].parentSessionId).toBe("parent-session");
    expect(hookEvents[0].sessionId).toBe(childSessionId);
    expect(hookEvents[1].event).toBe("SubagentStop");
    expect(hookEvents[1].parentSessionId).toBe("parent-session");
    expect(hookEvents[1].sessionId).toBe(childSessionId);
  });
});

describe("preventContinuation in streaming path", () => {
  let fs: MockFs;
  let computer: MockComputer;
  let provider: MockAIProvider;

  beforeEach(() => {
    fs = new MockFs({ "/project/test.txt": "hello" });
    computer = new MockComputer();
    provider = new MockAIProvider();
  });

  it("stops the agent loop when PostToolUse sets preventContinuation (streaming)", async () => {
    const hook: HookDefinition = {
      event: "PostToolUse",
      handler: async () => ({ preventContinuation: true }),
    };

    provider.addResponse(
      toolCallResponse("tc1", "ReadFile", { file_path: "/project/test.txt" }),
    );

    const config: ThreadConfig = {
      aiProvider: provider,
      fs,
      computer,
      sessionDir: "/sessions",
      hooks: [hook],
      streamingToolExecution: true,
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };

    const thread = new Thread(config, { sessionId: "stream-test" });
    const events = await collectEvents(thread.run("read file"));

    const turnComplete = events.find((e) => e.type === "turn_complete");
    expect(turnComplete).toBeUndefined();

    expect(provider.calls).toHaveLength(1);
  });

  it("stops the agent loop when PostToolUse sets preventContinuation (batched)", async () => {
    const hook: HookDefinition = {
      event: "PostToolUse",
      handler: async () => ({ preventContinuation: true }),
    };

    provider.addResponse(
      toolCallResponse("tc1", "ReadFile", { file_path: "/project/test.txt" }),
    );

    const config: ThreadConfig = {
      aiProvider: provider,
      fs,
      computer,
      sessionDir: "/sessions",
      hooks: [hook],
      streamingToolExecution: false,
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };

    const thread = new Thread(config, { sessionId: "batch-test" });
    const events = await collectEvents(thread.run("read file"));

    const turnComplete = events.find((e) => e.type === "turn_complete");
    expect(turnComplete).toBeUndefined();

    expect(provider.calls).toHaveLength(1);
  });
});
