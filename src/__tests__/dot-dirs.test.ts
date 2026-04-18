import { describe, it, expect } from "vitest";
import {
  DEFAULT_DOT_DIRS,
  createDotDirResolver,
  readFirstDotDir,
  readAllDotDirs,
} from "../config/dot-dirs.js";
import { MockFs } from "./helpers.js";

describe("DEFAULT_DOT_DIRS", () => {
  it("prefers .noumen then .claude", () => {
    expect(DEFAULT_DOT_DIRS.names).toEqual([".noumen", ".claude"]);
  });
});

describe("createDotDirResolver", () => {
  it("throws on empty names array", () => {
    expect(() => createDotDirResolver({ names: [] })).toThrow();
  });

  it("candidates returns ordered paths", () => {
    const resolver = createDotDirResolver();
    expect(resolver.candidates("/x")).toEqual(["/x/.noumen", "/x/.claude"]);
  });

  it("writePath returns the first candidate", () => {
    const resolver = createDotDirResolver();
    expect(resolver.writePath("/x")).toBe("/x/.noumen");
  });

  it("joinRead preserves preference order", () => {
    const resolver = createDotDirResolver();
    expect(resolver.joinRead("/x", "config.json")).toEqual([
      "/x/.noumen/config.json",
      "/x/.claude/config.json",
    ]);
  });

  it("joinWrite routes to the first candidate", () => {
    const resolver = createDotDirResolver();
    expect(resolver.joinWrite("/x", "config.json")).toBe("/x/.noumen/config.json");
  });

  it("respects a custom names list (write target + read order)", () => {
    const resolver = createDotDirResolver({ names: [".cursor", ".noumen"] });
    expect(resolver.writePath("/x")).toBe("/x/.cursor");
    expect(resolver.candidates("/x")).toEqual(["/x/.cursor", "/x/.noumen"]);
  });

  it("supports a single-name list (no fallback)", () => {
    const resolver = createDotDirResolver({ names: [".noumen"] });
    expect(resolver.candidates("/x")).toEqual(["/x/.noumen"]);
    expect(resolver.writePath("/x")).toBe("/x/.noumen");
  });

  it("handles trailing slash on base gracefully", () => {
    const resolver = createDotDirResolver();
    expect(resolver.writePath("/x/")).toBe("/x/.noumen");
  });

  it("handles root base", () => {
    const resolver = createDotDirResolver();
    expect(resolver.writePath("/")).toBe("/.noumen");
  });

  it("clones names so external mutation does not affect the resolver", () => {
    const names = [".noumen", ".claude"];
    const resolver = createDotDirResolver({ names });
    names.push(".cursor");
    expect(resolver.config.names).toEqual([".noumen", ".claude"]);
  });
});

describe("readFirstDotDir", () => {
  it("returns the .noumen file when both exist", async () => {
    const fs = new MockFs({
      "/proj/.noumen/config.json": "noumen",
      "/proj/.claude/config.json": "claude",
    });
    const resolver = createDotDirResolver();
    const hit = await readFirstDotDir(fs, resolver, "/proj", "config.json");
    expect(hit).toEqual({
      path: "/proj/.noumen/config.json",
      content: "noumen",
    });
  });

  it("falls back to .claude when .noumen absent", async () => {
    const fs = new MockFs({
      "/proj/.claude/config.json": "claude",
    });
    const resolver = createDotDirResolver();
    const hit = await readFirstDotDir(fs, resolver, "/proj", "config.json");
    expect(hit).toEqual({
      path: "/proj/.claude/config.json",
      content: "claude",
    });
  });

  it("returns null when no candidate exists", async () => {
    const fs = new MockFs();
    const resolver = createDotDirResolver();
    const hit = await readFirstDotDir(fs, resolver, "/proj", "config.json");
    expect(hit).toBeNull();
  });

  it("honors a custom names list (first-hit-wins order)", async () => {
    const fs = new MockFs({
      "/proj/.noumen/config.json": "noumen",
      "/proj/.cursor/config.json": "cursor",
    });
    const resolver = createDotDirResolver({ names: [".cursor", ".noumen"] });
    const hit = await readFirstDotDir(fs, resolver, "/proj", "config.json");
    expect(hit?.path).toBe("/proj/.cursor/config.json");
    expect(hit?.content).toBe("cursor");
  });
});

describe("readAllDotDirs", () => {
  it("returns both files in low-to-high precedence order", async () => {
    const fs = new MockFs({
      "/proj/.noumen/NOUMEN.md": "noumen",
      "/proj/.claude/CLAUDE.md": "claude",
    });
    const resolver = createDotDirResolver();
    const noumenHit = await readAllDotDirs(fs, resolver, "/proj", "NOUMEN.md");
    expect(noumenHit.map((h) => h.path)).toEqual(["/proj/.noumen/NOUMEN.md"]);
  });

  it("orders multi-dir reads so names[0] ends last (highest precedence)", async () => {
    const fs = new MockFs({
      "/proj/.claude/shared.json": "claude",
      "/proj/.noumen/shared.json": "noumen",
    });
    const resolver = createDotDirResolver();
    const all = await readAllDotDirs(fs, resolver, "/proj", "shared.json");
    expect(all.map((h) => h.content)).toEqual(["claude", "noumen"]);
  });

  it("returns empty array when nothing matches", async () => {
    const fs = new MockFs();
    const resolver = createDotDirResolver();
    const all = await readAllDotDirs(fs, resolver, "/proj", "missing.md");
    expect(all).toEqual([]);
  });

  it("skips candidates that do not exist", async () => {
    const fs = new MockFs({
      "/proj/.noumen/only.md": "only noumen",
    });
    const resolver = createDotDirResolver();
    const all = await readAllDotDirs(fs, resolver, "/proj", "only.md");
    expect(all).toHaveLength(1);
    expect(all[0].path).toBe("/proj/.noumen/only.md");
  });
});
