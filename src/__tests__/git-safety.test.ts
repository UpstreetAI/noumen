import { describe, it, expect } from "vitest";
import { classifyCommand } from "../tools/shell-safety/command-classification.js";
import {
  isGitInternalPath,
  looksLikeBareRepo,
  commandWritesGitInternals,
} from "../tools/shell-safety/git-safety.js";
import {
  detectGitOperations,
  hasGitIndexLockError,
} from "../tools/shell-safety/git-tracking.js";

describe("git injection guards", () => {
  it("flags git -c as destructive", () => {
    const result = classifyCommand("git -c core.fsmonitor=malicious.sh status");
    expect(result.isReadOnly).toBe(false);
    expect(result.isDestructive).toBe(true);
    expect(result.reason).toContain("injection");
  });

  it("flags git --exec-path= as destructive", () => {
    const result = classifyCommand("git --exec-path=/tmp/evil status");
    expect(result.isReadOnly).toBe(false);
    expect(result.isDestructive).toBe(true);
  });

  it("flags git --config-env= as destructive", () => {
    const result = classifyCommand("git --config-env=core.editor=EDITOR status");
    expect(result.isReadOnly).toBe(false);
    expect(result.isDestructive).toBe(true);
  });
});

describe("fine-grained git flag validation", () => {
  it("classifies git config --get as read-only", () => {
    const result = classifyCommand("git config --get user.name");
    expect(result.isReadOnly).toBe(true);
  });

  it("classifies git config --list as read-only", () => {
    const result = classifyCommand("git config --list");
    expect(result.isReadOnly).toBe(true);
  });

  it("classifies git config set operation as mutating", () => {
    const result = classifyCommand('git config user.name "Test"');
    expect(result.isReadOnly).toBe(false);
  });

  it("classifies git config --unset as mutating", () => {
    const result = classifyCommand("git config --unset user.name");
    expect(result.isReadOnly).toBe(false);
  });

  it("classifies git remote -v as read-only", () => {
    const result = classifyCommand("git remote -v");
    expect(result.isReadOnly).toBe(true);
  });

  it("classifies git remote add as mutating", () => {
    const result = classifyCommand("git remote add upstream https://example.com");
    expect(result.isReadOnly).toBe(false);
  });

  it("classifies git remote remove as mutating", () => {
    const result = classifyCommand("git remote remove upstream");
    expect(result.isReadOnly).toBe(false);
  });

  it("classifies git tag -d as destructive", () => {
    const result = classifyCommand("git tag -d v1.0.0");
    expect(result.isReadOnly).toBe(false);
    expect(result.isDestructive).toBe(true);
  });

  it("classifies git stash drop as destructive", () => {
    const result = classifyCommand("git stash drop");
    expect(result.isReadOnly).toBe(false);
    expect(result.isDestructive).toBe(true);
  });

  it("classifies git stash clear as destructive", () => {
    const result = classifyCommand("git stash clear");
    expect(result.isReadOnly).toBe(false);
    expect(result.isDestructive).toBe(true);
  });

  it("classifies git stash list as read-only", () => {
    const result = classifyCommand("git stash list");
    expect(result.isReadOnly).toBe(true);
  });
});

describe("git --output flag bypass prevention", () => {
  it("classifies git diff --output as NOT read-only", () => {
    const result = classifyCommand("git diff --output=/tmp/evil");
    expect(result.isReadOnly).toBe(false);
    expect(result.reason).toContain("--output");
  });

  it("classifies git diff --output=file as NOT read-only", () => {
    const result = classifyCommand("git diff --output=out.patch");
    expect(result.isReadOnly).toBe(false);
  });

  it("classifies git log --output as NOT read-only", () => {
    const result = classifyCommand("git log --output=out.txt");
    expect(result.isReadOnly).toBe(false);
    expect(result.reason).toContain("--output");
  });

  it("classifies git show --output as NOT read-only", () => {
    const result = classifyCommand("git show --output=/etc/crontab");
    expect(result.isReadOnly).toBe(false);
  });

  it("classifies git blame --output as NOT read-only", () => {
    const result = classifyCommand("git blame --output=/tmp/pwned file.ts");
    expect(result.isReadOnly).toBe(false);
  });

  it("still allows git diff --stat (safe flag)", () => {
    const result = classifyCommand("git diff --stat");
    expect(result.isReadOnly).toBe(true);
  });

  it("still allows git diff --cached (safe flag)", () => {
    const result = classifyCommand("git diff --cached");
    expect(result.isReadOnly).toBe(true);
  });

  it("still allows git log --oneline -n 10 (safe flags)", () => {
    const result = classifyCommand("git log --oneline -n 10");
    expect(result.isReadOnly).toBe(true);
  });

  it("still allows git show HEAD (safe positional)", () => {
    const result = classifyCommand("git show HEAD");
    expect(result.isReadOnly).toBe(true);
  });

  it("still allows git diff HEAD~1 (safe positional)", () => {
    const result = classifyCommand("git diff HEAD~1");
    expect(result.isReadOnly).toBe(true);
  });
});

describe("git reflog sub-command validation", () => {
  it("classifies bare git reflog as read-only", () => {
    const result = classifyCommand("git reflog");
    expect(result.isReadOnly).toBe(true);
  });

  it("classifies git reflog show as read-only", () => {
    const result = classifyCommand("git reflog show");
    expect(result.isReadOnly).toBe(true);
  });

  it("classifies git reflog list as read-only", () => {
    const result = classifyCommand("git reflog list");
    expect(result.isReadOnly).toBe(true);
  });

  it("classifies git reflog expire as destructive", () => {
    const result = classifyCommand("git reflog expire --expire=now --all");
    expect(result.isReadOnly).toBe(false);
    expect(result.isDestructive).toBe(true);
    expect(result.reason).toContain("expire");
  });

  it("classifies git reflog delete as destructive", () => {
    const result = classifyCommand("git reflog delete HEAD@{0}");
    expect(result.isReadOnly).toBe(false);
    expect(result.isDestructive).toBe(true);
    expect(result.reason).toContain("delete");
  });
});

describe("cd + git compound guard", () => {
  it("flags cd && git as non-read-only", () => {
    const result = classifyCommand("cd /tmp/repo && git status");
    expect(result.isReadOnly).toBe(false);
    expect(result.reason).toContain("cd + git");
  });

  it("flags pushd + git as non-read-only", () => {
    const result = classifyCommand("pushd /tmp/repo && git log");
    expect(result.isReadOnly).toBe(false);
    expect(result.reason).toContain("cd + git");
  });

  it("does not flag standalone git commands", () => {
    const result = classifyCommand("git status");
    expect(result.isReadOnly).toBe(true);
  });

  it("does not flag cd without git as bare-repo risk", () => {
    const result = classifyCommand("cd /tmp && ls");
    expect(result.reason).not.toContain("cd + git");
  });
});

describe("xargs git normalization", () => {
  it("classifies xargs git add as mutating", () => {
    const result = classifyCommand("find . -name '*.ts' | xargs git add");
    // The pipeline contains xargs git which is classified as git
    expect(result.isReadOnly).toBe(false);
  });

  it("classifies xargs git status as read-only", () => {
    const result = classifyCommand("echo foo | xargs git status");
    expect(result.isReadOnly).toBe(true);
  });
});

describe("isGitInternalPath", () => {
  it("detects .git/hooks paths", () => {
    expect(isGitInternalPath(".git/hooks/pre-commit")).toBe(true);
  });

  it("detects .git/config", () => {
    expect(isGitInternalPath(".git/config")).toBe(true);
  });

  it("detects .git/objects paths", () => {
    expect(isGitInternalPath(".git/objects/pack/foo")).toBe(true);
  });

  it("detects .git/refs paths", () => {
    expect(isGitInternalPath(".git/refs/heads/main")).toBe(true);
  });

  it("does not flag normal paths", () => {
    expect(isGitInternalPath("src/main.ts")).toBe(false);
    expect(isGitInternalPath(".gitignore")).toBe(false);
    expect(isGitInternalPath(".github/workflows/ci.yml")).toBe(false);
  });

  it("handles Windows-style paths", () => {
    expect(isGitInternalPath(".git\\hooks\\pre-commit")).toBe(true);
  });
});

describe("looksLikeBareRepo", () => {
  it("detects bare repo layout", () => {
    expect(looksLikeBareRepo(["HEAD", "objects", "refs", "config", "description"])).toBe(true);
  });

  it("does not flag normal repo (has .git dir)", () => {
    expect(looksLikeBareRepo([".git", "src", "package.json"])).toBe(false);
  });

  it("does not flag incomplete bare repo", () => {
    expect(looksLikeBareRepo(["HEAD", "config"])).toBe(false);
  });

  it("handles trailing slashes", () => {
    expect(looksLikeBareRepo(["HEAD", "objects/", "refs/", "config"])).toBe(true);
  });
});

describe("commandWritesGitInternals", () => {
  it("detects redirect to .git/hooks", () => {
    expect(commandWritesGitInternals("echo '#!/bin/sh' > .git/hooks/pre-commit")).toBe(true);
  });

  it("detects tee to .git/config", () => {
    expect(commandWritesGitInternals("echo '[core]' | tee .git/config")).toBe(true);
  });

  it("detects cp to .git paths", () => {
    expect(commandWritesGitInternals("cp evil.sh .git/hooks/post-checkout")).toBe(true);
  });

  it("does not flag normal commands", () => {
    expect(commandWritesGitInternals("git status")).toBe(false);
    expect(commandWritesGitInternals("echo hello > output.txt")).toBe(false);
  });
});

describe("detectGitOperations", () => {
  it("detects git commit from output", () => {
    const ops = detectGitOperations(
      "git commit -m 'fix bug'",
      "[main abc1234] fix bug\n 1 file changed, 2 insertions(+)",
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("commit");
    expect(ops[0].details).toContain("abc1234");
  });

  it("detects git push", () => {
    const ops = detectGitOperations(
      "git push origin main",
      "To github.com:user/repo.git\n   abc1234..def5678  main -> main",
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("push");
    expect(ops[0].details).toContain("origin");
  });

  it("detects gh pr create", () => {
    const ops = detectGitOperations(
      "gh pr create --title 'Fix' --body 'Fix the bug'",
      "https://github.com/user/repo/pull/42\n",
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("pr_create");
    expect(ops[0].details).toContain("pull/42");
  });

  it("detects git merge", () => {
    const ops = detectGitOperations("git merge feature-branch", "Merge made by");
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("merge");
    expect(ops[0].details).toContain("feature-branch");
  });

  it("detects git rebase", () => {
    const ops = detectGitOperations("git rebase main", "Successfully rebased");
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("rebase");
    expect(ops[0].details).toContain("main");
  });

  it("returns empty for non-git commands", () => {
    const ops = detectGitOperations("ls -la", "total 8\ndrwxr-xr-x...");
    expect(ops).toHaveLength(0);
  });
});

describe("hasGitIndexLockError", () => {
  it("detects index.lock in output", () => {
    expect(
      hasGitIndexLockError("fatal: Unable to create '.git/index.lock': File exists."),
    ).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(hasGitIndexLockError("On branch main\nnothing to commit")).toBe(false);
  });
});
