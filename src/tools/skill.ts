import type { Tool, ToolResult, ToolContext } from "./types.js";
import type { SkillDefinition } from "../skills/types.js";

/**
 * Create a Skill tool that lets the model invoke skills by name.
 * Skill content is expanded inline with $ARGUMENTS substitution.
 */
export function createSkillTool(
  getSkills: () => SkillDefinition[],
): Tool {
  return {
    name: "Skill",
    description:
      "Invoke a skill by name with optional arguments. " +
      "Available skills are listed in the system prompt. " +
      "The skill's instructions will be expanded and returned for you to follow.",
    parameters: {
      type: "object",
      properties: {
        skill_name: {
          type: "string",
          description: "The name of the skill to invoke",
        },
        arguments: {
          type: "string",
          description: "Arguments to pass to the skill (replaces $ARGUMENTS in skill content)",
        },
      },
      required: ["skill_name"],
    },
    async call(
      args: Record<string, unknown>,
      _ctx: ToolContext,
    ): Promise<ToolResult> {
      const skillName = args.skill_name as string;
      const skillArgs = (args.arguments as string) ?? "";
      const skills = getSkills();

      const skill = skills.find(
        (s) => s.name.toLowerCase() === skillName.toLowerCase(),
      );

      if (!skill) {
        const available = skills.map((s) => s.name).join(", ");
        return {
          content: `Unknown skill: "${skillName}". Available skills: ${available || "none"}`,
          isError: true,
        };
      }

      let content = skill.content;
      content = content.replace(/\$ARGUMENTS/g, skillArgs);

      const header = `# Skill: ${skill.name}`;
      const desc = skill.description ? `\n${skill.description}\n` : "";

      return {
        content: `${header}${desc}\n${content}`,
      };
    },
  };
}
