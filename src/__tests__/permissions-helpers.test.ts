import { describe, it, expect, vi } from "vitest";
import {
  extractContentHint,
  resolveAcceptEditsDecision,
  resolveAutoModeDecision,
} from "../permissions/helpers.js";
import type { Tool } from "../tools/types.js";
import { DenialTracker } from "../permissions/denial-tracking.js";

function makeTool(overrides?: Partial<Tool>): Tool {
  return {
    name: "TestTool",
    description: "",
    parameters: { type: "object", properties: {} },
    call: async () => ({ content: "" }),
    ...overrides,
  };
}

function expectMessage(result: { behavior: string; message?: string }, substring: string): void {
  expect(result.behavior).not.toBe("allow");
  expect((result as { message: string }).message).toContain(substring);
}

// ---------------------------------------------------------------------------
// extractContentHint
// ---------------------------------------------------------------------------

describe("extractContentHint", () => {
  it("returns file_path when present", () => {
    expect(extractContentHint(makeTool(), { file_path: "/a/b.ts" })).toBe("/a/b.ts");
  });

  it("returns command when present", () => {
    expect(extractContentHint(makeTool(), { command: "ls -la" })).toBe("ls -la");
  });

  it("returns path when present", () => {
    expect(extractContentHint(makeTool(), { path: "/foo" })).toBe("/foo");
  });

  it("prefers file_path over command and path", () => {
    expect(extractContentHint(makeTool(), { file_path: "/a", command: "x", path: "/b" })).toBe("/a");
  });

  it("prefers command over path when no file_path", () => {
    expect(extractContentHint(makeTool(), { command: "x", path: "/b" })).toBe("x");
  });

  it("returns undefined for empty input", () => {
    expect(extractContentHint(makeTool(), {})).toBeUndefined();
  });

  it("returns undefined for non-string values", () => {
    expect(extractContentHint(makeTool(), { file_path: 42 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveAcceptEditsDecision
// ---------------------------------------------------------------------------

describe("resolveAcceptEditsDecision", () => {
  const base = {
    toolName: "WriteFile",
    input: { file_path: "/project/foo.ts", content: "x" },
    effectiveInput: { file_path: "/project/foo.ts", content: "x" },
    isReadOnly: false,
    isDestructive: false,
    workingDirectories: [] as string[],
  };

  it("asks for destructive tools", () => {
    const result = resolveAcceptEditsDecision({ ...base, isDestructive: true });
    expect(result.behavior).toBe("ask");
    expect(result.reason).toBe("mode");
    expectMessage(result, "destructive");
  });

  it("allows file-path tools that are not destructive", () => {
    const result = resolveAcceptEditsDecision(base);
    expect(result.behavior).toBe("allow");
  });

  it("allows read-only tools", () => {
    const result = resolveAcceptEditsDecision({
      ...base,
      toolName: "ReadFile",
      isReadOnly: true,
      input: { file_path: "/project/foo.ts" },
      effectiveInput: { file_path: "/project/foo.ts" },
    });
    expect(result.behavior).toBe("allow");
  });

  it("asks for non-file, non-bash, non-read-only tools", () => {
    const result = resolveAcceptEditsDecision({
      ...base,
      toolName: "WebFetch",
      input: { url: "https://example.com" },
      effectiveInput: { url: "https://example.com" },
    });
    expect(result.behavior).toBe("ask");
    expect(result.reason).toBe("mode");
  });

  describe("Bash handling", () => {
    const bashBase = {
      ...base,
      toolName: "Bash",
      input: { command: "mkdir /project/dir" },
      effectiveInput: { command: "mkdir /project/dir" },
    };

    it("allows allowlisted Bash commands", () => {
      const result = resolveAcceptEditsDecision(bashBase);
      expect(result.behavior).toBe("allow");
    });

    it("asks for non-allowlisted Bash commands", () => {
      const result = resolveAcceptEditsDecision({
        ...bashBase,
        input: { command: "rm -rf /project" },
        effectiveInput: { command: "rm -rf /project" },
      });
      expect(result.behavior).toBe("ask");
      expectMessage(result, "allowlist");
    });

    it("checks each sub-command in compound Bash", () => {
      const result = resolveAcceptEditsDecision({
        ...bashBase,
        input: { command: "mkdir /a && git status" },
        effectiveInput: { command: "mkdir /a && git status" },
      });
      expect(result.behavior).toBe("ask");
      expectMessage(result, "git");
    });

    it("asks when Bash references paths outside working directories", () => {
      const result = resolveAcceptEditsDecision({
        ...bashBase,
        input: { command: "cp /outside/file /project/file" },
        effectiveInput: { command: "cp /outside/file /project/file" },
        workingDirectories: ["/project"],
      });
      expect(result.behavior).toBe("ask");
      expect(result.reason).toBe("workingDirectory");
    });

    it("allows Bash with absolute paths inside working directories", () => {
      const result = resolveAcceptEditsDecision({
        ...bashBase,
        input: { command: "cp /project/a /project/b" },
        effectiveInput: { command: "cp /project/a /project/b" },
        workingDirectories: ["/project"],
      });
      expect(result.behavior).toBe("allow");
    });
  });

  describe("working directory enforcement", () => {
    it("asks when file_path is outside working directories", () => {
      const result = resolveAcceptEditsDecision({
        ...base,
        input: { file_path: "/other/file.ts" },
        effectiveInput: { file_path: "/other/file.ts" },
        workingDirectories: ["/project"],
      });
      expect(result.behavior).toBe("ask");
      expect(result.reason).toBe("workingDirectory");
    });

    it("allows when file_path is inside working directories", () => {
      const result = resolveAcceptEditsDecision({
        ...base,
        input: { file_path: "/project/file.ts" },
        effectiveInput: { file_path: "/project/file.ts" },
        workingDirectories: ["/project"],
      });
      expect(result.behavior).toBe("allow");
    });

    it("uses path input when file_path is absent", () => {
      const result = resolveAcceptEditsDecision({
        ...base,
        input: { path: "/other/dir" },
        effectiveInput: { path: "/other/dir" },
        workingDirectories: ["/project"],
      });
      expect(result.behavior).toBe("ask");
      expect(result.reason).toBe("workingDirectory");
    });
  });
});

// ---------------------------------------------------------------------------
// resolveAutoModeDecision
// ---------------------------------------------------------------------------

describe("resolveAutoModeDecision", () => {
  const base = {
    toolName: "ReadFile",
    effectiveInput: { file_path: "/project/foo.ts" },
    classifierResult: { shouldBlock: false, reason: "" },
    requiresUserInteraction: false,
  };

  it("allows when classifier approves", () => {
    const result = resolveAutoModeDecision(base);
    expect(result.behavior).toBe("allow");
    expect(result.reason).toBe("classifier");
  });

  it("denies when classifier blocks", () => {
    const result = resolveAutoModeDecision({
      ...base,
      classifierResult: { shouldBlock: true, reason: "dangerous" },
    });
    expect(result.behavior).toBe("deny");
    expect(result.reason).toBe("classifier");
    expectMessage(result, "dangerous");
  });

  it("asks for interactive tools even when classifier approves", () => {
    const result = resolveAutoModeDecision({
      ...base,
      requiresUserInteraction: true,
    });
    expect(result.behavior).toBe("ask");
    expect(result.reason).toBe("interaction");
  });

  it("records success on denial tracker when approved", () => {
    const tracker = new DenialTracker();
    const spy = vi.spyOn(tracker, "recordSuccess");
    resolveAutoModeDecision({ ...base, denialTracker: tracker });
    expect(spy).toHaveBeenCalledOnce();
  });

  describe("denial tracker interactions", () => {
    it("records denial and returns deny by default", () => {
      const tracker = new DenialTracker({ maxConsecutive: 10, maxTotal: 100 });
      const result = resolveAutoModeDecision({
        ...base,
        classifierResult: { shouldBlock: true, reason: "risk" },
        denialTracker: tracker,
      });
      expect(result.behavior).toBe("deny");
      expect(result.reason).toBe("classifier");
    });

    it("falls back to ask after consecutive denials", () => {
      const tracker = new DenialTracker({ maxConsecutive: 2, maxTotal: 100 });
      tracker.recordDenial();

      const result = resolveAutoModeDecision({
        ...base,
        classifierResult: { shouldBlock: true, reason: "risk" },
        denialTracker: tracker,
      });
      expect(result.behavior).toBe("ask");
      expect(result.reason).toBe("denial_limit");
    });

    it("hard denies on repeated_consecutive", () => {
      const tracker = new DenialTracker({ maxConsecutive: 1, maxTotal: 100 });
      tracker.recordDenial();
      const fb = tracker.shouldFallback();
      if (fb.triggered) tracker.resetAfterFallback(fb.reason as "consecutive" | "total");
      tracker.recordDenial();

      const result = resolveAutoModeDecision({
        ...base,
        classifierResult: { shouldBlock: true, reason: "risk" },
        denialTracker: tracker,
      });
      expect(result.behavior).toBe("deny");
      expect(result.reason).toBe("denial_limit");
      expectMessage(result, "Aborting");
    });
  });
});
