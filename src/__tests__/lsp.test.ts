import { describe, it, expect } from "vitest";
import { DiagnosticRegistry } from "../lsp/diagnostics.js";
import type { LspDiagnostic } from "../lsp/types.js";

function diag(
  filePath: string,
  overrides: Partial<Omit<LspDiagnostic, "filePath">> = {},
): LspDiagnostic {
  return {
    filePath,
    line: 0,
    character: 0,
    severity: "error",
    message: "m",
    ...overrides,
  };
}

describe("DiagnosticRegistry", () => {
  it("register stores diagnostics grouped by file", () => {
    const reg = new DiagnosticRegistry();
    const a = diag("/a.ts", { message: "a1" });
    const b1 = diag("/b.ts", { message: "b1" });
    const b2 = diag("/b.ts", { message: "b2" });
    reg.register([a, b1, b2]);
    const all = reg.peek();
    expect(all).toHaveLength(3);
    expect(all.filter((d) => d.filePath === "/a.ts")).toEqual([a]);
    expect(all.filter((d) => d.filePath === "/b.ts")).toEqual([b1, b2]);
  });

  it("register skips empty arrays", () => {
    const reg = new DiagnosticRegistry();
    reg.register([]);
    expect(reg.hasPending()).toBe(false);
    reg.register([diag("/x.ts")]);
    reg.register([]);
    expect(reg.peek()).toHaveLength(1);
  });

  it("register caps at 50 per file", () => {
    const reg = new DiagnosticRegistry();
    const file = "/many.ts";
    const batch: LspDiagnostic[] = [];
    for (let i = 0; i < 60; i++) {
      batch.push(diag(file, { message: String(i) }));
    }
    reg.register(batch);
    const forFile = reg.peek().filter((d) => d.filePath === file);
    expect(forFile).toHaveLength(50);
    expect(forFile[0]?.message).toBe("0");
    expect(forFile[49]?.message).toBe("49");
  });

  it("clearForFile removes diagnostics for a file", () => {
    const reg = new DiagnosticRegistry();
    reg.register([diag("/keep.ts"), diag("/drop.ts")]);
    reg.clearForFile("/drop.ts");
    expect(reg.peek().map((d) => d.filePath)).toEqual(["/keep.ts"]);
  });

  it("flush returns all diagnostics and clears", () => {
    const reg = new DiagnosticRegistry();
    const d1 = diag("/a.ts");
    const d2 = diag("/b.ts");
    reg.register([d1, d2]);
    const flushed = reg.flush();
    expect(flushed).toHaveLength(2);
    expect(flushed).toContainEqual(d1);
    expect(flushed).toContainEqual(d2);
    expect(reg.hasPending()).toBe(false);
    expect(reg.peek()).toHaveLength(0);
  });

  it("peek returns diagnostics without clearing", () => {
    const reg = new DiagnosticRegistry();
    reg.register([diag("/a.ts")]);
    expect(reg.peek()).toHaveLength(1);
    expect(reg.peek()).toHaveLength(1);
    expect(reg.hasPending()).toBe(true);
  });

  it("hasPending returns true when diagnostics exist, false when empty", () => {
    const reg = new DiagnosticRegistry();
    expect(reg.hasPending()).toBe(false);
    reg.register([diag("/a.ts")]);
    expect(reg.hasPending()).toBe(true);
    reg.flush();
    expect(reg.hasPending()).toBe(false);
  });
});
