import type { SkillDefinition } from "./types.js";

/**
 * Check which skills should be activated based on file paths the agent touched.
 * Skills with `globs` are conditional -- they only activate when a matching file is touched.
 * Skills without `globs` are always active.
 *
 * Returns the names of newly-activated conditional skills.
 */
export function activateSkillsForPaths(
  allSkills: SkillDefinition[],
  filePaths: string[],
  cwd: string,
  alreadyActivated: Set<string>,
): string[] {
  const activated: string[] = [];

  for (const skill of allSkills) {
    if (!skill.globs || skill.globs.length === 0) continue;
    if (alreadyActivated.has(skill.name)) continue;

    for (const filePath of filePaths) {
      const relative = filePath.startsWith(cwd)
        ? filePath.slice(cwd.endsWith("/") ? cwd.length : cwd.length + 1)
        : filePath;

      if (matchesAnyGlob(relative, skill.globs)) {
        alreadyActivated.add(skill.name);
        activated.push(skill.name);
        break;
      }
    }
  }

  return activated;
}

/**
 * Get all currently active skills: unconditional ones + activated conditional ones.
 */
export function getActiveSkills(
  allSkills: SkillDefinition[],
  activatedNames: Set<string>,
): SkillDefinition[] {
  return allSkills.filter((skill) => {
    if (!skill.globs || skill.globs.length === 0) return true;
    return activatedNames.has(skill.name);
  });
}

/**
 * Simple glob matching. Supports *, **, and ? wildcards.
 * This is intentionally minimal -- covers the common SKILL.md patterns like
 * "*.ts", "src/**", "**\/*.test.ts" without pulling in a dependency.
 */
function matchesAnyGlob(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globMatch(pattern, path));
}

function globMatch(pattern: string, str: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(str);
}

function globToRegex(glob: string): RegExp {
  let result = "";
  let i = 0;

  while (i < glob.length) {
    const ch = glob[i];

    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // ** matches any path segment(s)
        if (glob[i + 2] === "/") {
          result += "(?:.*/)?";
          i += 3;
        } else {
          result += ".*";
          i += 2;
        }
      } else {
        // * matches anything except /
        result += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      result += "[^/]";
      i++;
    } else if (ch === "{") {
      // Brace expansion: {a,b,c}
      const close = glob.indexOf("}", i);
      if (close !== -1) {
        const alternatives = glob.slice(i + 1, close).split(",");
        result += `(?:${alternatives.map(escapeRegex).join("|")})`;
        i = close + 1;
      } else {
        result += escapeRegex(ch);
        i++;
      }
    } else {
      result += escapeRegex(ch);
      i++;
    }
  }

  return new RegExp(`^${result}$`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
