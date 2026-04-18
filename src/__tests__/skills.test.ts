import { describe, it, expect, beforeEach } from "vitest";
import { MockFs } from "./helpers.js";
import { loadSkills } from "../skills/loader.js";
import { buildUserContext } from "../prompt/context.js";
import { createDotDirResolver } from "../config/dot-dirs.js";

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

describe("buildUserContext auto-discovery", () => {
  it("discovers skills under <cwd>/.noumen/skills", async () => {
    fs.files.set("/project/.noumen/skills/foo/SKILL.md", "# Foo\nFoo skill.");
    fs.dirs.add("/project/.noumen");
    fs.dirs.add("/project/.noumen/skills");
    fs.dirs.add("/project/.noumen/skills/foo");

    const ctx = await buildUserContext({
      fs,
      dotDirResolver: createDotDirResolver(),
      cwd: "/project",
    });
    expect(ctx.skills.map((s) => s.name)).toEqual(["Foo"]);
  });

  it("falls back to .claude/skills when .noumen absent", async () => {
    fs.files.set("/project/.claude/skills/bar/SKILL.md", "# Bar\nBar skill.");
    fs.dirs.add("/project/.claude/skills");
    fs.dirs.add("/project/.claude/skills/bar");

    const ctx = await buildUserContext({
      fs,
      dotDirResolver: createDotDirResolver(),
      cwd: "/project",
    });
    expect(ctx.skills.map((s) => s.name)).toEqual(["Bar"]);
  });

  it("noumen wins on collision with claude (same skill name)", async () => {
    fs.files.set("/project/.noumen/skills/shared/SKILL.md", "# Shared\nNoumen version.");
    fs.files.set("/project/.claude/skills/shared/SKILL.md", "# Shared\nClaude version.");
    fs.dirs.add("/project/.noumen/skills");
    fs.dirs.add("/project/.noumen/skills/shared");
    fs.dirs.add("/project/.claude/skills");
    fs.dirs.add("/project/.claude/skills/shared");

    const ctx = await buildUserContext({
      fs,
      dotDirResolver: createDotDirResolver(),
      cwd: "/project",
    });
    expect(ctx.skills).toHaveLength(1);
    expect(ctx.skills[0].content).toContain("Noumen version");
  });

  it("discovers home-scope skills and stacks them under project skills", async () => {
    fs.files.set("/home/.noumen/skills/shared/SKILL.md", "# Shared\nHome version.");
    fs.files.set("/project/.noumen/skills/shared/SKILL.md", "# Shared\nProject version.");
    fs.dirs.add("/home/.noumen/skills");
    fs.dirs.add("/home/.noumen/skills/shared");
    fs.dirs.add("/project/.noumen/skills");
    fs.dirs.add("/project/.noumen/skills/shared");

    const ctx = await buildUserContext({
      fs,
      dotDirResolver: createDotDirResolver(),
      cwd: "/project",
      homeDir: "/home",
    });
    expect(ctx.skills).toHaveLength(1);
    expect(ctx.skills[0].content).toContain("Project version");
  });

  it("explicit skillsPaths stacks on top of discovered skills", async () => {
    fs.files.set("/project/.noumen/skills/foo/SKILL.md", "# Foo\nDiscovered foo.");
    fs.files.set("/custom/foo/SKILL.md", "# Foo\nExplicit foo.");
    fs.dirs.add("/project/.noumen/skills");
    fs.dirs.add("/project/.noumen/skills/foo");
    fs.dirs.add("/custom");
    fs.dirs.add("/custom/foo");

    const ctx = await buildUserContext({
      fs,
      dotDirResolver: createDotDirResolver(),
      cwd: "/project",
      skillsPaths: ["/custom"],
    });
    expect(ctx.skills).toHaveLength(1);
    expect(ctx.skills[0].content).toContain("Explicit foo");
  });

  it("inline skills beat discovered skills of the same name", async () => {
    fs.files.set("/project/.noumen/skills/foo/SKILL.md", "# Foo\nDiscovered foo.");
    fs.dirs.add("/project/.noumen/skills");
    fs.dirs.add("/project/.noumen/skills/foo");

    const ctx = await buildUserContext({
      fs,
      dotDirResolver: createDotDirResolver(),
      cwd: "/project",
      inlineSkills: [{ name: "Foo", content: "Inline foo." }],
    });
    expect(ctx.skills).toHaveLength(1);
    expect(ctx.skills[0].content).toBe("Inline foo.");
  });

  it("dotDirs: ['.noumen'] excludes .claude/skills from auto-discovery", async () => {
    fs.files.set("/project/.noumen/skills/noum/SKILL.md", "# Noum\nNoumen skill.");
    fs.files.set("/project/.claude/skills/clau/SKILL.md", "# Clau\nClaude skill.");
    fs.dirs.add("/project/.noumen/skills");
    fs.dirs.add("/project/.noumen/skills/noum");
    fs.dirs.add("/project/.claude/skills");
    fs.dirs.add("/project/.claude/skills/clau");

    const ctx = await buildUserContext({
      fs,
      dotDirResolver: createDotDirResolver({ names: [".noumen"] }),
      cwd: "/project",
    });
    expect(ctx.skills.map((s) => s.name)).toEqual(["Noum"]);
  });

  it("loose <dotdir>/SKILL.md at the root is NOT picked up", async () => {
    fs.files.set("/project/.noumen/SKILL.md", "# Loose\nLoose skill.");
    // No /project/.noumen/skills/ directory at all.

    const ctx = await buildUserContext({
      fs,
      dotDirResolver: createDotDirResolver(),
      cwd: "/project",
    });
    expect(ctx.skills).toHaveLength(0);
  });

  it("auto-discovery is a no-op when dotDirResolver is omitted", async () => {
    fs.files.set("/project/.noumen/skills/foo/SKILL.md", "# Foo\nFoo.");
    fs.dirs.add("/project/.noumen/skills");
    fs.dirs.add("/project/.noumen/skills/foo");

    const ctx = await buildUserContext({ fs, cwd: "/project" });
    expect(ctx.skills).toHaveLength(0);
  });
});
