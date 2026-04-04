/**
 * Git operation tracking.
 *
 * Parses shell command + output to detect high-level git operations
 * (commits, pushes, PR creation, merges, rebases). Adapted from
 * claude-code's gitOperationTracking.ts.
 */

export type GitOperationType =
  | "commit"
  | "push"
  | "pr_create"
  | "merge"
  | "rebase";

export interface GitOperationEvent {
  type: GitOperationType;
  details: string;
}

/**
 * Detect git operations from a command string and its stdout output.
 * Returns an array of events (most commands produce 0 or 1).
 * Only detects on success — caller should check exit code first.
 */
export function detectGitOperations(
  command: string,
  stdout: string,
): GitOperationEvent[] {
  const events: GitOperationEvent[] = [];
  const cmd = command.trim();

  // git commit
  if (/\bgit\s+commit\b/.test(cmd)) {
    const shaMatch = stdout.match(/\[[\w/.-]+\s+([0-9a-f]{7,40})\]/);
    const sha = shaMatch ? shaMatch[1] : "unknown";
    events.push({ type: "commit", details: `commit ${sha}` });
  }

  // git merge
  if (/\bgit\s+merge\b/.test(cmd)) {
    const branchMatch = cmd.match(/\bgit\s+merge\s+(?:--\S+\s+)*(\S+)/);
    const branch = branchMatch ? branchMatch[1] : "unknown";
    events.push({ type: "merge", details: `merge ${branch}` });
  }

  // git rebase
  if (/\bgit\s+rebase\b/.test(cmd)) {
    const branchMatch = cmd.match(/\bgit\s+rebase\s+(?:--\S+\s+)*(\S+)/);
    const branch = branchMatch ? branchMatch[1] : "unknown";
    events.push({ type: "rebase", details: `rebase onto ${branch}` });
  }

  // git push
  if (/\bgit\s+push\b/.test(cmd)) {
    const remoteMatch = cmd.match(/\bgit\s+push\s+(?:--\S+\s+)*(\S+)/);
    const remote = remoteMatch ? remoteMatch[1] : "origin";
    const branchMatch = stdout.match(/\S+\s+->\s+(\S+)/);
    const branch = branchMatch ? branchMatch[1] : "";
    events.push({
      type: "push",
      details: `push to ${remote}${branch ? ` (${branch})` : ""}`,
    });
  }

  // gh pr create / glab mr create
  if (/\b(gh\s+pr\s+create|glab\s+mr\s+create)\b/.test(cmd)) {
    const urlMatch = stdout.match(/(https?:\/\/\S+(?:pull|merge_requests)\/\d+)/);
    const url = urlMatch ? urlMatch[1] : "";
    events.push({
      type: "pr_create",
      details: url ? `PR created: ${url}` : "PR created",
    });
  }

  return events;
}

/**
 * Check if command output indicates a git index.lock error.
 * This commonly occurs when another git process is running.
 */
export function hasGitIndexLockError(output: string): boolean {
  return /\.git\/index\.lock/.test(output);
}
