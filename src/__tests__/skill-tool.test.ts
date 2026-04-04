import { describe, it, expect } from "vitest";
import { createSkillTool } from "../tools/skill.js";
import type { SkillDefinition } from "../skills/types.js";
import type { ToolContext } from "../tools/types.js";
import { MockFs, MockComputer } from "./helpers.js";

function makeCtx(): ToolContext {
  return {
    fs: new MockFs(),
    computer: new MockComputer(),
    cwd: "/",
  };
}

describe("createSkillTool", () => {
  const skills: SkillDefinition[] = [
    {
      name: "deploy",
      content: "Deploy the project using $ARGUMENTS.",
      description: "Deploys the project",
    },
    {
      name: "test",
      content: "Run vitest tests in the project.",
    },
  ];

  const skillTool = createSkillTool(() => skills);

  it("has correct name and parameters", () => {
    expect(skillTool.name).toBe("Skill");
    expect(skillTool.parameters.required).toContain("skill_name");
  });

  it("expands skill content by name", async () => {
    const result = await skillTool.call({ skill_name: "deploy", arguments: "staging" }, makeCtx());
    expect(result.content).toContain("# Skill: deploy");
    expect(result.content).toContain("Deploy the project using staging.");
    expect(result.isError).toBeUndefined();
  });

  it("substitutes $ARGUMENTS in skill content", async () => {
    const result = await skillTool.call({ skill_name: "deploy", arguments: "production" }, makeCtx());
    expect(result.content).toContain("Deploy the project using production.");
  });

  it("handles missing arguments (empty substitution)", async () => {
    const result = await skillTool.call({ skill_name: "deploy" }, makeCtx());
    expect(result.content).toContain("Deploy the project using .");
  });

  it("returns error for unknown skill", async () => {
    const result = await skillTool.call({ skill_name: "nonexistent" }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown skill");
    expect(result.content).toContain("deploy");
  });

  it("matches skill name case-insensitively", async () => {
    const result = await skillTool.call({ skill_name: "Deploy" }, makeCtx());
    expect(result.content).toContain("# Skill: deploy");
    expect(result.isError).toBeUndefined();
  });

  it("includes description in output when available", async () => {
    const result = await skillTool.call({ skill_name: "deploy" }, makeCtx());
    expect(result.content).toContain("Deploys the project");
  });

  it("works with skill content that has no $ARGUMENTS", async () => {
    const result = await skillTool.call({ skill_name: "test", arguments: "ignored" }, makeCtx());
    expect(result.content).toContain("Run vitest tests");
  });
});
