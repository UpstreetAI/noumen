import type { SkillDefinition } from "../skills/types.js";
import type { VirtualFs } from "../virtual/fs.js";
import type { DotDirResolver } from "../config/dot-dirs.js";
import { loadSkills } from "../skills/loader.js";

export interface UserContext {
  skills: SkillDefinition[];
  date: string;
}

/**
 * Build the user-context section of the prompt. Resolves skills from:
 *   1. Home-scope dot-dirs:    <home>/<dotdir>/skills
 *   2. Project-scope dot-dirs: <cwd ancestors>/<dotdir>/skills (root → cwd)
 *   3. Explicit `skillsPaths`
 *   4. Inline `skills`
 *
 * Later entries have higher precedence. On name collisions, the last-loaded
 * skill wins (inline > explicit > project > home; within a layer, a dot-dir
 * listed later in the config wins — consistent with the context loader).
 *
 * Auto-discovery is unconditional: omit `dotDirResolver` (or pass a
 * VirtualFs with no matching dirs) to get a clean slate, e.g. in tests.
 */
export async function buildUserContext(opts: {
  fs: VirtualFs;
  skillsPaths?: string[];
  inlineSkills?: SkillDefinition[];
  dotDirResolver?: DotDirResolver;
  cwd?: string;
  homeDir?: string;
}): Promise<UserContext> {
  const ordered: SkillDefinition[] = [];

  if (opts.dotDirResolver) {
    // Within a base dir, load candidates in reverse so that `names[0]`
    // (the preferred dir, e.g. `.noumen`) ends up loaded LAST. Combined
    // with the last-wins dedupe below, that means `.noumen` beats
    // `.claude` on skill-name collisions. Project ancestors are walked
    // root→cwd so deeper ancestors win over shallower ones.
    if (opts.homeDir) {
      const homeDirs = opts.dotDirResolver
        .candidates(opts.homeDir)
        .slice()
        .reverse()
        .map((d) => `${d}/skills`);
      const homeSkills = await loadSkills(opts.fs, homeDirs);
      ordered.push(...homeSkills);
    }

    if (opts.cwd) {
      const ancestors = walkAncestors(opts.cwd);
      for (const ancestor of ancestors) {
        const ancestorDirs = opts.dotDirResolver
          .candidates(ancestor)
          .slice()
          .reverse()
          .map((d) => `${d}/skills`);
        const ancestorSkills = await loadSkills(opts.fs, ancestorDirs);
        ordered.push(...ancestorSkills);
      }
    }
  }

  if (opts.skillsPaths && opts.skillsPaths.length > 0) {
    const loaded = await loadSkills(opts.fs, opts.skillsPaths);
    ordered.push(...loaded);
  }

  if (opts.inlineSkills) {
    ordered.push(...opts.inlineSkills);
  }

  const skills = dedupeSkillsByName(ordered);

  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return { skills, date };
}

/**
 * Deduplicate skills by `name`, last-wins. Preserves insertion order of
 * the winning entries so higher-precedence skills appear later in the
 * final list (matching how the context loader stacks rules).
 */
function dedupeSkillsByName(skills: SkillDefinition[]): SkillDefinition[] {
  const byName = new Map<string, SkillDefinition>();
  for (const skill of skills) {
    byName.set(skill.name, skill);
  }
  return Array.from(byName.values());
}

/**
 * Walk from filesystem root down to `cwd` (root first = lowest priority).
 * Mirrors the project walk in the context loader.
 */
function walkAncestors(cwd: string): string[] {
  const normalized = cwd.endsWith("/") && cwd.length > 1 ? cwd.slice(0, -1) : cwd;
  const parts = normalized.split("/");
  const dirs: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join("/") || "/";
    dirs.push(dir);
  }
  return dirs;
}
