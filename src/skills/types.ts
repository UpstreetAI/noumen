export interface SkillDefinition {
  name: string;
  content: string;
  path?: string;
  description?: string;
  /** Glob patterns for files this skill applies to */
  globs?: string[];
}
