export type ContextScope = "managed" | "user" | "project" | "local";

export interface ContextFile {
  path: string;
  scope: ContextScope;
  content: string;
  /** Glob patterns from frontmatter `paths:` field. Undefined = unconditional. */
  globs?: string[];
  /** Files included via @ references. */
  includes?: ContextFile[];
}

export interface ProjectContextConfig {
  /** Working directory (project root). Required. */
  cwd: string;
  /** User home directory. Pass explicitly for sandboxed environments. */
  homeDir?: string;
  /** Managed settings directory (enterprise/MDM). Optional. */
  managedDir?: string;
  /** Glob patterns to exclude context files (picomatch-style). */
  excludes?: string[];
  /** Maximum include depth for @ references. Default: 5. */
  maxIncludeDepth?: number;
  /** Whether to load .claude/ files in addition to .noumen/ files. Default: true. */
  loadClaudeMd?: boolean;
  /** Enable loading user-scope context from homeDir. Default: true. */
  loadUserContext?: boolean;
  /** Enable loading project-scope context from cwd ancestors. Default: true. */
  loadProjectContext?: boolean;
  /** Enable loading local-scope (.local.md) context. Default: true. */
  loadLocalContext?: boolean;
}
