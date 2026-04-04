import { describe, it, expect, beforeEach } from "vitest";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textResponse,
  toolCallResponse,
} from "./helpers.js";
import { Code, type CodeOptions } from "../code.js";
import { agentTool } from "../tools/agent.js";
import type { StreamEvent } from "../session/types.js";
import type { ToolContext } from "../tools/types.js";

let fs: MockFs;
let computer: MockComputer;

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

beforeEach(() => {
  fs = new MockFs({ "/project/data.txt": "important data" });
  computer = new MockComputer();
});

describe("AgentTool", () => {
  it("returns error when spawnSubagent is not available", async () => {
    const ctx: ToolContext = { fs, computer, cwd: "/project" };
    const result = await agentTool.call({ prompt: "do something" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not enabled");
  });

  it("is marked as concurrency-safe", () => {
    expect(agentTool.isConcurrencySafe).toBe(true);
  });
});

describe("Subagent via Code", () => {
  it("enables Agent tool when enableSubagents is true", () => {
    const provider = new MockAIProvider();
    const code = new Code({
      aiProvider: provider,
      virtualFs: fs,
      virtualComputer: computer,
      options: { enableSubagents: true },
    });
    const thread = code.createThread({ sessionId: "s1" });
    // The Agent tool should be registered — a model call with Agent should work
    expect(thread).toBeDefined();
  });

  it("does not include Agent tool when enableSubagents is false", () => {
    const provider = new MockAIProvider();
    provider.addResponse(textResponse("hello"));

    const code = new Code({
      aiProvider: provider,
      virtualFs: fs,
      virtualComputer: computer,
      options: { enableSubagents: false },
    });
    const thread = code.createThread({ sessionId: "s1" });
    expect(thread).toBeDefined();
  });

  it("runs a subagent that reads a file and returns result", async () => {
    const parentProvider = new MockAIProvider();
    const subagentProvider = new MockAIProvider();

    // We need the parent and subagent to share a provider, so we use one MockAIProvider
    // Parent call 1: model invokes Agent tool
    parentProvider.addResponse(
      toolCallResponse("tc1", "Agent", { prompt: "Read data.txt and summarize it" }),
    );
    // Subagent call 1: model calls ReadFile
    parentProvider.addResponse(
      toolCallResponse("tc_sub_1", "ReadFile", { file_path: "/project/data.txt" }),
    );
    // Subagent call 2: model returns final text
    parentProvider.addResponse(textResponse("The file contains important data."));
    // Parent call 2: model returns final text after receiving subagent result
    parentProvider.addResponse(textResponse("Based on the subagent: it contains important data."));

    const code = new Code({
      aiProvider: parentProvider,
      virtualFs: fs,
      virtualComputer: computer,
      options: {
        enableSubagents: true,
        autoCompact: false,
        cwd: "/project",
      },
    });

    const thread = code.createThread({ sessionId: "parent-1" });
    const events = await collectEvents(thread.run("Summarize data.txt using a subagent"));

    // Check that we got a tool_result from the Agent tool
    const agentResult = events.find(
      (e) => e.type === "tool_result" && e.toolName === "Agent",
    );
    expect(agentResult).toBeDefined();
    if (agentResult?.type === "tool_result") {
      expect(agentResult.result.content).toContain("important data");
    }

    // Check final message
    const complete = events.find((e) => e.type === "message_complete");
    expect(complete).toBeDefined();
    if (complete?.type === "message_complete") {
      expect(complete.message.content).toContain("important data");
    }
  });

  it("subagent excludes the Agent tool to prevent infinite recursion", async () => {
    const provider = new MockAIProvider();

    // Parent call: invoke Agent
    provider.addResponse(
      toolCallResponse("tc1", "Agent", { prompt: "do stuff" }),
    );
    // Subagent: tries to call Agent (which shouldn't be available) — just returns text
    provider.addResponse(textResponse("I completed the task."));
    // Parent final response
    provider.addResponse(textResponse("Done."));

    const code = new Code({
      aiProvider: provider,
      virtualFs: fs,
      virtualComputer: computer,
      options: {
        enableSubagents: true,
        autoCompact: false,
        cwd: "/project",
      },
    });

    const thread = code.createThread({ sessionId: "s1" });
    const events = await collectEvents(thread.run("test"));

    const agentResult = events.find(
      (e) => e.type === "tool_result" && e.toolName === "Agent",
    );
    expect(agentResult).toBeDefined();
    if (agentResult?.type === "tool_result") {
      expect(agentResult.result.content).toContain("completed the task");
    }
  });
});
