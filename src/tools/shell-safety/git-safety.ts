/**
 * Git-specific safety checks.
 *
 * Detects bare repositories, git-internal path writes, and other
 * attack vectors (e.g. hook injection via .git/hooks/). Adapted from
 * claude-code's gitSafety.ts and git.ts.
 */

/**
 * Paths inside `.git/` that are security-sensitive: writing to these
 * can inject hooks, alter config, or corrupt the repo.
 */
const GIT_INTERNAL_PATTERNS = [
  /\.git\/hooks\//,
  /\.git\/config$/,
  /\.git\/info\//,
  /\.git\/objects\//,
  /\.git\/refs\//,
  /\.git\/HEAD$/,
  /\.git\/index$/,
  /\.git\/packed-refs$/,
  /\.git\/shallow$/,
  /\.git\/modules\//,
];

/**
 * Returns true if `path` targets a file inside `.git/` internals.
 * Used to detect attempts to write hooks, alter config, etc.
 */
export function isGitInternalPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return GIT_INTERNAL_PATTERNS.some((p) => p.test(normalized));
}

/**
 * Top-level entries expected in a bare git repository.
 * A bare repo has HEAD, objects/, refs/ at the top level with no
 * `.git` subdirectory — git operations in a bare repo can still
 * trigger hooks (e.g. post-checkout, fsmonitor) and are a known
 * sandbox-escape vector.
 */
const BARE_REPO_MARKERS = ["HEAD", "objects", "refs"];

/**
 * Heuristic: does `dirEntries` (a list of filenames/dirnames in a
 * directory) look like a bare git repository?
 *
 * Returns true when all three markers (HEAD, objects/, refs/) are
 * present *and* there is no `.git` entry (which would indicate a
 * normal working tree).
 */
export function looksLikeBareRepo(dirEntries: string[]): boolean {
  const entrySet = new Set(dirEntries.map((e) => e.replace(/\/$/, "")));
  if (entrySet.has(".git")) return false;
  return BARE_REPO_MARKERS.every((m) => entrySet.has(m));
}

/**
 * Check if a shell command targets git-internal paths for writes.
 * Scans for redirect operators (`>`, `>>`, `tee`) whose target is
 * inside `.git/`.
 */
export function commandWritesGitInternals(command: string): boolean {
  // Redirect targets: > .git/hooks/pre-commit, >> .git/config, tee .git/hooks/x
  const redirectPattern = /(?:>{1,2}|tee\s+)\s*(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = redirectPattern.exec(command)) !== null) {
    if (isGitInternalPath(match[1])) return true;
  }

  // cp/mv/ln targeting .git/ paths
  const copyPattern = /\b(?:cp|mv|ln)\b.*\s(\S*\.git\/\S+)/;
  const copyMatch = command.match(copyPattern);
  if (copyMatch && isGitInternalPath(copyMatch[1])) return true;

  return false;
}
