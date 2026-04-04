import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../prompt/system.js";
import { buildUserContext } from "../prompt/context.js";
import { MockFs } from "./helpers.js";

describe("buildSystemPrompt", () => {
  it("returns base prompt with date when no options", () => {
    const prompt = buildSystemPrompt({ date: "Monday, January 1, 2024" });
    expect(prompt).toContain("AI coding assistant");
    expect(prompt).toContain("Monday, January 1, 2024");
  });

  it("returns only custom prompt when provided", () => {
    const prompt = buildSystemPrompt({ customPrompt: "You are a pirate." });
    expect(prompt).toBe("You are a pirate.");
  });

  it("includes skill sections", () => {
    const prompt = buildSystemPrompt({
      date: "Today",
      skills: [
        { name: "Testing", content: "Always test.", description: "Test stuff" },
      ],
    });
    expect(prompt).toContain("# Available Skills");
    expect(prompt).toContain("## Skill: Testing - Test stuff");
    expect(prompt).toContain("Always test.");
  });

  it("omits skills section when empty", () => {
    const prompt = buildSystemPrompt({ date: "Today", skills: [] });
    expect(prompt).not.toContain("# Available Skills");
  });

  it("includes base prompt sections", () => {
    const prompt = buildSystemPrompt({ date: "Today" });
    expect(prompt).toContain("# System");
    expect(prompt).toContain("# Doing tasks");
    expect(prompt).toContain("# Code style");
    expect(prompt).toContain("# Using your tools");
    expect(prompt).toContain("# Executing actions with care");
  });
});

describe("buildUserContext", () => {
  it("returns inline skills", async () => {
    const fs = new MockFs();
    const ctx = await buildUserContext({
      fs,
      inlineSkills: [{ name: "S1", content: "content" }],
    });
    expect(ctx.skills).toHaveLength(1);
    expect(ctx.skills[0].name).toBe("S1");
  });

  it("loads and merges skills from paths", async () => {
    const fs = new MockFs({
      "/skills/a.md": "# From Path\nLoaded from path.",
    });
    fs.dirs.add("/skills");

    const ctx = await buildUserContext({
      fs,
      skillsPaths: ["/skills"],
      inlineSkills: [{ name: "Inline", content: "inline content" }],
    });
    expect(ctx.skills).toHaveLength(2);
    expect(ctx.skills.map((s) => s.name).sort()).toEqual([
      "From Path",
      "Inline",
    ]);
  });

  it("returns a date string", async () => {
    const fs = new MockFs();
    const ctx = await buildUserContext({ fs });
    expect(ctx.date).toBeTruthy();
  });
});
