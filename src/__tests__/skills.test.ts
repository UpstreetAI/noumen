import { describe, it, expect, beforeEach } from "vitest";
import { MockFs } from "./helpers.js";
import { loadSkills } from "../skills/loader.js";

let fs: MockFs;

beforeEach(() => {
  fs = new MockFs();
});

describe("loadSkills", () => {
  it("loads a SKILL.md from a direct file path", async () => {
    fs.files.set("/skills/testing/SKILL.md", "# Testing\nAlways write tests.");
    fs.dirs.add("/skills/testing");

    const skills = await loadSkills(fs, ["/skills/testing/SKILL.md"]);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("Testing");
    expect(skills[0].content).toContain("Always write tests.");
    expect(skills[0].path).toBe("/skills/testing/SKILL.md");
  });

  it("extracts name from H1 heading", async () => {
    fs.files.set("/s.md", "# My Skill Name\nSome content.");
    const skills = await loadSkills(fs, ["/s.md"]);
    expect(skills[0].name).toBe("My Skill Name");
  });

  it("falls back to directory name for SKILL.md", async () => {
    fs.files.set("/skills/linting/SKILL.md", "Use eslint for all code.");
    fs.dirs.add("/skills/linting");

    const skills = await loadSkills(fs, ["/skills/linting/SKILL.md"]);
    expect(skills[0].name).toBe("linting");
  });

  it("falls back to filename without .md", async () => {
    fs.files.set("/rules.md", "Follow the rules.");
    const skills = await loadSkills(fs, ["/rules.md"]);
    expect(skills[0].name).toBe("rules");
  });

  it("extracts description from first non-heading line", async () => {
    fs.files.set("/s.md", "# Title\nThis is the description.\nMore content.");
    const skills = await loadSkills(fs, ["/s.md"]);
    expect(skills[0].description).toBe("This is the description.");
  });

  it("skips missing paths", async () => {
    const skills = await loadSkills(fs, ["/does/not/exist"]);
    expect(skills).toHaveLength(0);
  });

  it("loads from directory scanning .md files", async () => {
    fs.files.set("/skills/a.md", "# Skill A\nDescription A.");
    fs.files.set("/skills/b.md", "# Skill B\nDescription B.");
    fs.dirs.add("/skills");

    const skills = await loadSkills(fs, ["/skills"]);
    expect(skills).toHaveLength(2);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["Skill A", "Skill B"]);
  });

  it("discovers SKILL.md inside subdirectories", async () => {
    fs.files.set("/skills/testing/SKILL.md", "# Testing Skill\nTest everything.");
    fs.dirs.add("/skills");
    fs.dirs.add("/skills/testing");

    const skills = await loadSkills(fs, ["/skills"]);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("Testing Skill");
  });
});
