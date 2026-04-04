import type { Tool } from "./types.js";
import {
  findGitRoot,
  createWorktree,
  removeWorktree,
  getWorktreeChanges,
  sanitizeWorktreeSlug,
} from "../utils/worktree.js";

export const enterWorktreeTool: Tool = {
  name: "EnterWorktree",
  description:
    "Create an isolated git worktree and switch into it. This creates a separate " +
    "working copy on a new branch so you can make changes without affecting the " +
    "main working directory. Use this for parallel or experimental work.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Optional name for the worktree (used as branch name suffix). " +
          "If omitted, a default name is generated.",
      },
    },
  },
  isReadOnly: false,

  async call(args, ctx) {
    const repoRoot = await findGitRoot(ctx.computer, ctx.cwd);
    if (!repoRoot) {
      return {
        content: "Not inside a git repository. Worktrees require git.",
        isError: true,
      };
    }

    const slug = sanitizeWorktreeSlug(
      (args.name as string) || `noumen-${Date.now()}`,
    );
    const worktreePath = `${repoRoot}/.noumen/worktrees/${slug}`;
    const branchName = `worktree-${slug}`;

    const result = await createWorktree(
      ctx.computer,
      repoRoot,
      worktreePath,
      branchName,
    );

    if (!result.success) {
      return {
        content: `Failed to create worktree: ${result.error}`,
        isError: true,
      };
    }

    if (ctx.setCwd) {
      ctx.setCwd(worktreePath);
    }

    return {
      content: JSON.stringify({
        worktreePath,
        worktreeBranch: branchName,
        previousCwd: ctx.cwd,
        message: `Created worktree at ${worktreePath} on branch ${branchName}. ` +
          "Working directory switched. Use ExitWorktree when done.",
      }),
    };
  },
};

export const exitWorktreeTool: Tool = {
  name: "ExitWorktree",
  description:
    "Exit the current worktree and return to the original working directory. " +
    'Use action "keep" to preserve the worktree, or "remove" to clean it up.',
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: 'Whether to "keep" the worktree or "remove" it',
        enum: ["keep", "remove"],
      },
      worktreePath: {
        type: "string",
        description: "Path to the worktree to exit (usually the current cwd)",
      },
      originalCwd: {
        type: "string",
        description: "Original working directory to return to",
      },
    },
    required: ["action", "worktreePath", "originalCwd"],
  },
  isReadOnly: false,

  async call(args, ctx) {
    const action = args.action as "keep" | "remove";
    const worktreePath = args.worktreePath as string;
    const originalCwd = args.originalCwd as string;

    if (action === "remove") {
      const changes = await getWorktreeChanges(ctx.computer, worktreePath);
      if (changes.hasChanges) {
        return {
          content: JSON.stringify({
            error: "Worktree has uncommitted changes or unpushed commits.",
            uncommittedFiles: changes.uncommittedFiles,
            unpushedCommits: changes.unpushedCommits,
            message:
              "Cannot remove worktree with pending changes. " +
              'Commit/push your changes first, or use action "keep".',
          }),
          isError: true,
        };
      }

      const repoRoot = await findGitRoot(ctx.computer, originalCwd);
      if (repoRoot) {
        const branchMatch = worktreePath.match(/worktrees\/(.+)$/);
        const branchName = branchMatch
          ? `worktree-${branchMatch[1]}`
          : undefined;
        const result = await removeWorktree(
          ctx.computer,
          repoRoot,
          worktreePath,
          branchName,
        );
        if (!result.success) {
          return {
            content: `Failed to remove worktree: ${result.error}`,
            isError: true,
          };
        }
      }
    }

    if (ctx.setCwd) {
      ctx.setCwd(originalCwd);
    }

    return {
      content: JSON.stringify({
        action,
        restoredCwd: originalCwd,
        message:
          action === "remove"
            ? "Worktree removed and working directory restored."
            : "Worktree kept. Working directory restored.",
      }),
    };
  },
};
