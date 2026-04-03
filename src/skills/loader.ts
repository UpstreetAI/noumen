import type { VirtualFs } from "../virtual/fs.js";
import type { SkillDefinition } from "./types.js";

/**
 * Load skill definitions from SKILL.md files found at the given paths on the VirtualFs.
 * Each path can be a directory (scanned for SKILL.md files) or a direct file.
 */
export async function loadSkills(
  fs: VirtualFs,
  paths: string[],
): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];

  for (const skillPath of paths) {
    try {
      const stat = await fs.stat(skillPath);

      if (stat.isFile) {
        const skill = await loadSkillFile(fs, skillPath);
        if (skill) skills.push(skill);
      } else if (stat.isDirectory) {
        const dirSkills = await loadSkillsFromDir(fs, skillPath);
        skills.push(...dirSkills);
      }
    } catch {
      // path doesn't exist or isn't accessible; skip
    }
  }

  return skills;
}

async function loadSkillFile(
  fs: VirtualFs,
  filePath: string,
): Promise<SkillDefinition | null> {
  try {
    const content = await fs.readFile(filePath);
    const name = extractSkillName(filePath, content);
    const description = extractDescription(content);

    return {
      name,
      content,
      path: filePath,
      description,
    };
  } catch {
    return null;
  }
}

async function loadSkillsFromDir(
  fs: VirtualFs,
  dirPath: string,
): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];

  try {
    const entries = await fs.readdir(dirPath);

    for (const entry of entries) {
      if (
        entry.isFile &&
        (entry.name === "SKILL.md" || entry.name.endsWith(".md"))
      ) {
        const skill = await loadSkillFile(fs, entry.path);
        if (skill) skills.push(skill);
      } else if (entry.isDirectory) {
        // Check for SKILL.md inside subdirectories
        const skillMdPath = `${entry.path}/SKILL.md`;
        const skill = await loadSkillFile(fs, skillMdPath);
        if (skill) skills.push(skill);
      }
    }
  } catch {
    // directory not readable; skip
  }

  return skills;
}

function extractSkillName(filePath: string, content: string): string {
  // Try to extract from first H1 heading
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();

  // Fall back to directory/file name
  const parts = filePath.split("/");
  const fileName = parts[parts.length - 1];
  if (fileName === "SKILL.md" && parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return fileName.replace(/\.md$/, "");
}

function extractDescription(content: string): string | undefined {
  // Take first non-heading, non-empty line as description
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---")) {
      return trimmed.slice(0, 200);
    }
  }
  return undefined;
}
