import type { SkillDefinition } from "../skills/types.js";
import type { VirtualFs } from "../virtual/fs.js";
import { loadSkills } from "../skills/loader.js";

export interface UserContext {
  skills: SkillDefinition[];
  date: string;
}

export async function buildUserContext(opts: {
  fs: VirtualFs;
  skillsPaths?: string[];
  inlineSkills?: SkillDefinition[];
}): Promise<UserContext> {
  let skills: SkillDefinition[] = [];

  if (opts.skillsPaths && opts.skillsPaths.length > 0) {
    const loaded = await loadSkills(opts.fs, opts.skillsPaths);
    skills.push(...loaded);
  }

  if (opts.inlineSkills) {
    skills.push(...opts.inlineSkills);
  }

  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return { skills, date };
}
