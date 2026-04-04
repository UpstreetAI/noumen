import type { VirtualComputer } from "../virtual/computer.js";

export interface WorktreeInfo {
  path: string;
  branch: string;
  head?: string;
}

/**
 * Find the git root directory from a given cwd.
 */
export async function findGitRoot(
  computer: VirtualComputer,
  cwd: string,
): Promise<string | null> {
  const result = await computer.executeCommand(
    "git rev-parse --show-toplevel",
    { cwd, timeout: 5000 },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

/**
 * Get the default branch name (main/master).
 */
export async function getDefaultBranch(
  computer: VirtualComputer,
  cwd: string,
): Promise<string> {
  const result = await computer.executeCommand(
    "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo refs/heads/main",
    { cwd, timeout: 5000 },
  );
  const ref = result.stdout.trim();
  return ref.replace("refs/remotes/origin/", "").replace("refs/heads/", "");
}

/**
 * Create a git worktree at the given path with the given branch name.
 */
export async function createWorktree(
  computer: VirtualComputer,
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  baseBranch?: string,
): Promise<{ success: boolean; error?: string }> {
  const base = baseBranch ?? (await getDefaultBranch(computer, repoRoot));
  const cmd = `git worktree add -B "${branchName}" "${worktreePath}" "${base}"`;
  const result = await computer.executeCommand(cmd, {
    cwd: repoRoot,
    timeout: 30000,
  });

  if (result.exitCode !== 0) {
    return { success: false, error: result.stderr.trim() || result.stdout.trim() };
  }
  return { success: true };
}

/**
 * Remove a git worktree.
 */
export async function removeWorktree(
  computer: VirtualComputer,
  repoRoot: string,
  worktreePath: string,
  branchName?: string,
): Promise<{ success: boolean; error?: string }> {
  const rmResult = await computer.executeCommand(
    `git worktree remove --force "${worktreePath}"`,
    { cwd: repoRoot, timeout: 15000 },
  );

  if (rmResult.exitCode !== 0) {
    return { success: false, error: rmResult.stderr.trim() };
  }

  if (branchName) {
    await computer.executeCommand(`git branch -D "${branchName}"`, {
      cwd: repoRoot,
      timeout: 5000,
    });
  }

  return { success: true };
}

/**
 * List existing git worktrees.
 */
export async function listWorktrees(
  computer: VirtualComputer,
  cwd: string,
): Promise<WorktreeInfo[]> {
  const result = await computer.executeCommand("git worktree list --porcelain", {
    cwd,
    timeout: 5000,
  });
  if (result.exitCode !== 0) return [];

  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push(current as WorktreeInfo);
      current = { path: line.slice(9) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "") {
      if (current.path) worktrees.push(current as WorktreeInfo);
      current = {};
    }
  }
  if (current.path) worktrees.push(current as WorktreeInfo);

  return worktrees;
}

/**
 * Check if a worktree has uncommitted changes or unpushed commits.
 */
export async function getWorktreeChanges(
  computer: VirtualComputer,
  worktreePath: string,
): Promise<{ hasChanges: boolean; uncommittedFiles: number; unpushedCommits: number }> {
  const statusResult = await computer.executeCommand(
    "git status --porcelain",
    { cwd: worktreePath, timeout: 5000 },
  );
  const uncommittedFiles = statusResult.stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0).length;

  const logResult = await computer.executeCommand(
    "git rev-list --count @{upstream}..HEAD 2>/dev/null || echo 0",
    { cwd: worktreePath, timeout: 5000 },
  );
  const unpushedCommits = parseInt(logResult.stdout.trim(), 10) || 0;

  return {
    hasChanges: uncommittedFiles > 0 || unpushedCommits > 0,
    uncommittedFiles,
    unpushedCommits,
  };
}

/**
 * Sanitize a name for use as a worktree slug/branch name.
 */
export function sanitizeWorktreeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}
