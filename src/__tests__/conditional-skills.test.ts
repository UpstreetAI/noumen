import { describe, it, expect } from "vitest";
import { activateSkillsForPaths, getActiveSkills } from "../skills/activation.js";
import type { SkillDefinition } from "../skills/types.js";

describe("activateSkillsForPaths", () => {
  const skills: SkillDefinition[] = [
    { name: "always", content: "Always active (no globs)" },
    { name: "ts-only", content: "TypeScript skill", globs: ["**/*.ts", "**/*.tsx"] },
    { name: "tests", content: "Test skill", globs: ["**/*.test.ts"] },
    { name: "docs", content: "Docs skill", globs: ["docs/**"] },
  ];

  it("activates skill when file matches glob", () => {
    const activated = new Set<string>();
    const result = activateSkillsForPaths(
      skills,
      ["src/index.ts"],
      "/project",
      activated,
    );
    expect(result).toContain("ts-only");
    expect(activated.has("ts-only")).toBe(true);
  });

  it("does not activate already-activated skills", () => {
    const activated = new Set(["ts-only"]);
    const result = activateSkillsForPaths(
      skills,
      ["src/index.ts"],
      "/project",
      activated,
    );
    expect(result).not.toContain("ts-only");
  });

  it("strips cwd prefix for matching", () => {
    const activated = new Set<string>();
    const result = activateSkillsForPaths(
      skills,
      ["/project/docs/readme.md"],
      "/project",
      activated,
    );
    expect(result).toContain("docs");
  });

  it("activates test skill for nested test files", () => {
    const activated = new Set<string>();
    const result = activateSkillsForPaths(
      skills,
      ["src/__tests__/foo.test.ts"],
      "/project",
      activated,
    );
    expect(result).toContain("tests");
    // ts-only also matches .ts extension
    expect(result).toContain("ts-only");
  });

  it("skips skills without globs", () => {
    const activated = new Set<string>();
    const result = activateSkillsForPaths(
      skills,
      ["anything.py"],
      "/project",
      activated,
    );
    expect(result).not.toContain("always");
  });

  it("handles empty file paths", () => {
    const activated = new Set<string>();
    const result = activateSkillsForPaths(skills, [], "/project", activated);
    expect(result).toEqual([]);
  });
});

describe("getActiveSkills", () => {
  const skills: SkillDefinition[] = [
    { name: "always", content: "Always active" },
    { name: "conditional", content: "Conditional", globs: ["*.ts"] },
    { name: "other", content: "Other conditional", globs: ["*.py"] },
  ];

  it("always includes skills without globs", () => {
    const active = getActiveSkills(skills, new Set());
    expect(active.map((s) => s.name)).toContain("always");
  });

  it("includes activated conditional skills", () => {
    const active = getActiveSkills(skills, new Set(["conditional"]));
    expect(active.map((s) => s.name)).toContain("conditional");
    expect(active.map((s) => s.name)).not.toContain("other");
  });

  it("excludes non-activated conditional skills", () => {
    const active = getActiveSkills(skills, new Set());
    expect(active.map((s) => s.name)).not.toContain("conditional");
    expect(active.map((s) => s.name)).not.toContain("other");
  });
});
