import { describe, it, expect } from "vitest";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textResponse,
  toolCallResponse,
} from "./helpers.js";
import { Thread, type ThreadConfig } from "../thread.js";
import type { StreamEvent } from "../session/types.js";
import type { HookDefinition, HookInput } from "../hooks/types.js";
import {
  runPostToolUseFailureHooks,
  runNotificationHooks,
} from "../hooks/runner.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";

function baseConfig(overrides?: Partial<ThreadConfig>): ThreadConfig {
  return {
    provider: new MockAIProvider([textResponse("done")]),
    fs: new MockFs(),
    computer: new MockComputer(),
    sessionDir: ".test-sessions",
    autoCompact: createAutoCompactConfig({ enabled: false }),
    ...overrides,
  };
}

async function collectEvents(thread: Thread, prompt: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of thread.run(prompt)) {
    events.push(e);
  }
  return events;
}

// ---------------------------------------------------------------------------
// runPostToolUseFailureHooks
// ---------------------------------------------------------------------------
describe("runPostToolUseFailureHooks", () => {
  it("runs hooks that match PostToolUseFailure event", async () => {
    const calls: string[] = [];
    const hooks: HookDefinition[] = [
      {
        event: "PostToolUseFailure",
        handler: async (input) => {
          calls.push((input as { toolName: string }).toolName);
          return {};
        },
      },
    ];
    await runPostToolUseFailureHooks(hooks, {
      event: "PostToolUseFailure",
      toolName: "Bash",
      toolInput: {},
      toolUseId: "tc1",
      toolOutput: "error msg",
      errorMessage: "error msg",
      sessionId: "s1",
    });
    expect(calls).toEqual(["Bash"]);
  });

  it("returns updatedOutput from failure hook", async () => {
    const hooks: HookDefinition[] = [
      {
        event: "PostToolUseFailure",
        handler: async () => ({ updatedOutput: "replaced" }),
      },
    ];
    const out = await runPostToolUseFailureHooks(hooks, {
      event: "PostToolUseFailure",
      toolName: "Bash",
      toolInput: {},
      toolUseId: "tc1",
      toolOutput: "original",
      errorMessage: "original",
      sessionId: "s1",
    });
    expect(out.updatedOutput).toBe("replaced");
  });
});

// ---------------------------------------------------------------------------
// SessionStart hook
// ---------------------------------------------------------------------------
describe("SessionStart hook", () => {
  it("fires at the start of thread.run() with isResume: false", async () => {
    const captured: HookInput[] = [];
    const hooks: HookDefinition[] = [
      {
        event: "SessionStart",
        handler: async (input) => { captured.push(input); },
      },
    ];
    const thread = new Thread(baseConfig({ hooks }));
    await collectEvents(thread, "hello");

    expect(captured).toHaveLength(1);
    const ev = captured[0] as { event: string; isResume: boolean; prompt: string };
    expect(ev.event).toBe("SessionStart");
    expect(ev.isResume).toBe(false);
    expect(ev.prompt).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// SessionEnd hook
// ---------------------------------------------------------------------------
describe("SessionEnd hook", () => {
  it("fires with reason 'complete' on normal run", async () => {
    const captured: HookInput[] = [];
    const hooks: HookDefinition[] = [
      {
        event: "SessionEnd",
        handler: async (input) => { captured.push(input); },
      },
    ];
    const thread = new Thread(baseConfig({ hooks }));
    await collectEvents(thread, "hello");

    expect(captured).toHaveLength(1);
    expect((captured[0] as { reason: string }).reason).toBe("complete");
  });

  it("fires with reason 'maxTurns' when max turns reached", async () => {
    const captured: HookInput[] = [];
    const hooks: HookDefinition[] = [
      {
        event: "SessionEnd",
        handler: async (input) => { captured.push(input); },
      },
    ];
    const provider = new MockAIProvider([
      toolCallResponse("tc1", "ReadFile", { file_path: "/x" }),
      textResponse("done"),
    ]);
    const thread = new Thread(baseConfig({ provider: provider, hooks }));
    const events: StreamEvent[] = [];
    for await (const e of thread.run("go", { maxTurns: 1 })) {
      events.push(e);
    }
    expect(captured).toHaveLength(1);
    expect((captured[0] as { reason: string }).reason).toBe("maxTurns");
  });
});

// ---------------------------------------------------------------------------
// ModelSwitch hook
// ---------------------------------------------------------------------------
describe("ModelSwitch hook", () => {
  it("fires from setModel()", async () => {
    const captured: HookInput[] = [];
    let resolveFired!: () => void;
    const fired = new Promise<void>((r) => { resolveFired = r; });
    const hooks: HookDefinition[] = [
      {
        event: "ModelSwitch",
        handler: async (input) => { captured.push(input); resolveFired(); },
      },
    ];
    const thread = new Thread(baseConfig({ hooks, model: "old-model" }), { model: "old-model" });
    thread.setModel("new-model");

    await fired;
    expect(captured).toHaveLength(1);
    const ev = captured[0] as { previousModel: string; newModel: string };
    expect(ev.previousModel).toBe("old-model");
    expect(ev.newModel).toBe("new-model");
  });

  it("fires from setProvider() when model changes", async () => {
    const captured: HookInput[] = [];
    let resolveFired!: () => void;
    const fired = new Promise<void>((r) => { resolveFired = r; });
    const hooks: HookDefinition[] = [
      {
        event: "ModelSwitch",
        handler: async (input) => { captured.push(input); resolveFired(); },
      },
    ];
    const thread = new Thread(baseConfig({ hooks, model: "m1" }), { model: "m1" });
    thread.setProvider(new MockAIProvider([textResponse("ok")]), "m2");

    await fired;
    expect(captured).toHaveLength(1);
    expect((captured[0] as { newModel: string }).newModel).toBe("m2");
  });

  it("does not fire when model stays the same", async () => {
    const captured: HookInput[] = [];
    const hooks: HookDefinition[] = [
      {
        event: "ModelSwitch",
        handler: async (input) => { captured.push(input); },
      },
    ];
    const thread = new Thread(baseConfig({ hooks, model: "same" }), { model: "same" });
    thread.setModel("same");
    // A microtask flush is enough — if the hook were going to fire, it would
    // already be queued. No wall-clock wait required.
    await Promise.resolve();
    await Promise.resolve();
    expect(captured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FileWrite hook via WriteFile tool
// ---------------------------------------------------------------------------
describe("FileWrite hook", () => {
  it("fires after successful WriteFile", async () => {
    const captured: HookInput[] = [];
    let resolveFired!: () => void;
    const fired = new Promise<void>((r) => { resolveFired = r; });
    const hooks: HookDefinition[] = [
      {
        event: "FileWrite",
        handler: async (input) => { captured.push(input); resolveFired(); },
      },
    ];
    const provider = new MockAIProvider([
      toolCallResponse("tc2", "WriteFile", { file_path: "/tmp/test.txt", content: "hello" }),
      textResponse("done"),
    ]);
    const thread = new Thread(baseConfig({
      provider: provider,
      hooks,
      permissions: { mode: "bypassPermissions" },
    }));
    await collectEvents(thread, "write a file");

    await fired;
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const ev = captured[0] as { toolName: string; filePath: string; isNew: boolean };
    expect(ev.toolName).toBe("WriteFile");
    expect(ev.filePath).toBe("/tmp/test.txt");
    expect(ev.isNew).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runNotificationHooks for new events
// ---------------------------------------------------------------------------
describe("runNotificationHooks with new event types", () => {
  it("dispatches PermissionRequest events", async () => {
    const captured: HookInput[] = [];
    const hooks: HookDefinition[] = [
      {
        event: "PermissionRequest",
        handler: async (input) => { captured.push(input); },
      },
    ];
    await runNotificationHooks(hooks, "PermissionRequest", {
      event: "PermissionRequest",
      sessionId: "s1",
      toolName: "Bash",
      input: { command: "ls" },
      mode: "default",
    } as HookInput);
    expect(captured).toHaveLength(1);
    expect((captured[0] as { toolName: string }).toolName).toBe("Bash");
  });

  it("dispatches PermissionDenied events", async () => {
    const captured: HookInput[] = [];
    const hooks: HookDefinition[] = [
      {
        event: "PermissionDenied",
        handler: async (input) => { captured.push(input); },
      },
    ];
    await runNotificationHooks(hooks, "PermissionDenied", {
      event: "PermissionDenied",
      sessionId: "s1",
      toolName: "Bash",
      input: {},
      reason: "blocked",
    } as HookInput);
    expect(captured).toHaveLength(1);
    expect((captured[0] as { reason: string }).reason).toBe("blocked");
  });

  it("dispatches RetryAttempt events", async () => {
    const captured: HookInput[] = [];
    const hooks: HookDefinition[] = [
      {
        event: "RetryAttempt",
        handler: async (input) => { captured.push(input); },
      },
    ];
    await runNotificationHooks(hooks, "RetryAttempt", {
      event: "RetryAttempt",
      sessionId: "s1",
      attempt: 1,
      maxAttempts: 3,
      error: "rate limit",
      delay: 1000,
    } as HookInput);
    expect(captured).toHaveLength(1);
    expect((captured[0] as { attempt: number }).attempt).toBe(1);
  });

  it("dispatches MemoryUpdate events", async () => {
    const captured: HookInput[] = [];
    const hooks: HookDefinition[] = [
      {
        event: "MemoryUpdate",
        handler: async (input) => { captured.push(input); },
      },
    ];
    await runNotificationHooks(hooks, "MemoryUpdate", {
      event: "MemoryUpdate",
      sessionId: "s1",
      entries: [{ type: "created", content: "new fact" }],
    } as HookInput);
    expect(captured).toHaveLength(1);
  });
});
