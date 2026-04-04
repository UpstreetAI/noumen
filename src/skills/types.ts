export interface SkillDefinition {
  name: string;
  /** Skill body content (after frontmatter is stripped) */
  content: string;
  path?: string;
  description?: string;
  /** Glob patterns for files this skill applies to (from frontmatter `paths`) */
  globs?: string[];
  /** Tool names this skill is allowed to use */
  allowedTools?: string[];
  /** Execution context: inline expands into conversation, fork runs as sub-agent */
  context?: "inline" | "fork";
  /** Hint for the $ARGUMENTS placeholder */
  argumentHint?: string;
}
