import type { DotDirConfig } from "../config/dot-dirs.js";

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
  /**
   * Dot-directory names to scan for `<NAME>.md`, `<NAME>.local.md`, and
   * `<dotDir>/rules/**`. Defaults to `{ names: [".noumen", ".claude"] }`.
   *
   * Markdown filenames derive from the dot-dir name: `.noumen` →
   * `NOUMEN.md` / `NOUMEN.local.md`, `.claude` → `CLAUDE.md` /
   * `CLAUDE.local.md`. The dir name (minus the leading dot, uppercased)
   * is the filename stem.
   */
  dotDirs?: DotDirConfig;
  /** Enable loading user-scope context from homeDir. Default: true. */
  loadUserContext?: boolean;
  /** Enable loading project-scope context from cwd ancestors. Default: true. */
  loadProjectContext?: boolean;
  /** Enable loading local-scope (.local.md) context. Default: true. */
  loadLocalContext?: boolean;
}
