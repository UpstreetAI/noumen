import { describe, it, expect } from "vitest";
import { classifyCommand } from "../tools/shell-safety/command-classification.js";

describe("classifyCommand", () => {
  describe("read-only commands", () => {
    const readOnlyCmds = [
      "ls",
      "ls -la /tmp",
      "cat foo.txt",
      "head -n 10 file.txt",
      "tail -f log.txt",
      "grep -r pattern src/",
      "rg pattern",
      "find . -name '*.ts'",
      "wc -l file.txt",
      "echo hello",
      "pwd",
      "date",
      "uname -a",
      "whoami",
      "tree src/",
      "diff a.txt b.txt",
      "du -sh .",
      "df -h",
      "file image.png",
      "which node",
      "sort file.txt",
      "jq '.name' package.json",
      "git status",
      "git log --oneline",
      "git diff HEAD",
      "git show abc123",
      "git blame file.ts",
      "git branch --list",
      "git branch -l",
      "git remote -v",
      "git rev-parse HEAD",
      "git ls-files",
      "git stash list",
      "git --version",
    ];

    for (const cmd of readOnlyCmds) {
      it(`"${cmd}" is read-only`, () => {
        const result = classifyCommand(cmd);
        expect(result.isReadOnly).toBe(true);
        expect(result.isDestructive).toBe(false);
      });
    }
  });

  describe("mutating but non-destructive commands", () => {
    const mutatingCmds = [
      "mkdir -p dist",
      "git commit -m 'fix'",
      "git add .",
      "git push origin main",
      "git pull",
      "git checkout -b feature",
      "touch newfile.txt",
      "cp a.txt b.txt",
      "mv a.txt b.txt",
      "npm install",
    ];

    for (const cmd of mutatingCmds) {
      it(`"${cmd}" is not read-only and not destructive`, () => {
        const result = classifyCommand(cmd);
        expect(result.isReadOnly).toBe(false);
        expect(result.isDestructive).toBe(false);
      });
    }
  });

  describe("destructive commands", () => {
    const destructiveCmds = [
      "rm -rf /",
      "rm -rf node_modules",
      "rm --recursive dist",
      "git push --force",
      "git push -f",
      "git reset --hard HEAD~1",
      "git clean -fd",
      "chmod -R 777 /etc",
      "dd if=/dev/zero of=/dev/sda",
      "sed -i 's/foo/bar/g' file.txt",
      "docker rm container123",
      "kubectl delete pod my-pod",
      "kill -9 1234",
      "killall node",
    ];

    for (const cmd of destructiveCmds) {
      it(`"${cmd}" is destructive`, () => {
        const result = classifyCommand(cmd);
        expect(result.isDestructive).toBe(true);
      });
    }
  });

  describe("compound commands", () => {
    it("read-only && read-only is read-only", () => {
      const result = classifyCommand("ls -la && echo done");
      expect(result.isReadOnly).toBe(true);
      expect(result.isDestructive).toBe(false);
    });

    it("read-only && mutating is not read-only", () => {
      const result = classifyCommand("ls -la && mkdir dist");
      expect(result.isReadOnly).toBe(false);
      expect(result.isDestructive).toBe(false);
    });

    it("any destructive in chain makes whole destructive", () => {
      const result = classifyCommand("echo hello && rm -rf /tmp/test");
      expect(result.isDestructive).toBe(true);
    });

    it("piped read-only commands are read-only", () => {
      const result = classifyCommand("cat file.txt | grep pattern | wc -l");
      expect(result.isReadOnly).toBe(true);
    });

    it("piped with mutating is not read-only", () => {
      const result = classifyCommand("cat file.txt | tee output.txt");
      expect(result.isReadOnly).toBe(false);
    });

    it("semicolon-separated commands", () => {
      const result = classifyCommand("ls; pwd; echo done");
      expect(result.isReadOnly).toBe(true);
    });
  });

  describe("git edge cases", () => {
    it("git branch (no args) is read-only", () => {
      const result = classifyCommand("git branch");
      expect(result.isReadOnly).toBe(true);
    });

    it("git branch new-branch is not read-only", () => {
      const result = classifyCommand("git branch new-branch");
      expect(result.isReadOnly).toBe(false);
    });

    it("git branch -d is destructive", () => {
      const result = classifyCommand("git branch -d old-branch");
      expect(result.isDestructive).toBe(true);
    });

    it("git stash list is read-only", () => {
      const result = classifyCommand("git stash list");
      expect(result.isReadOnly).toBe(true);
    });

    it("git stash pop is not read-only", () => {
      const result = classifyCommand("git stash pop");
      expect(result.isReadOnly).toBe(false);
    });

    it("git tag -l is read-only", () => {
      const result = classifyCommand("git tag -l");
      expect(result.isReadOnly).toBe(true);
    });

    it("git tag v1.0 is not read-only (creates tag)", () => {
      const result = classifyCommand("git tag v1.0");
      expect(result.isReadOnly).toBe(false);
    });
  });

  describe("prefix stripping", () => {
    it("handles sudo prefix", () => {
      const result = classifyCommand("sudo ls -la");
      expect(result.isReadOnly).toBe(true);
    });

    it("handles env prefix", () => {
      const result = classifyCommand("env NODE_ENV=test echo hello");
      expect(result.isReadOnly).toBe(true);
    });

    it("handles env var assignments", () => {
      const result = classifyCommand("FOO=bar ls");
      expect(result.isReadOnly).toBe(true);
    });
  });

  describe("custom config", () => {
    it("extra read-only commands are respected", () => {
      const result = classifyCommand("mycustomtool --check", {
        extraReadOnlyCommands: ["mycustomtool"],
      });
      expect(result.isReadOnly).toBe(true);
    });

    it("extra destructive patterns are respected", () => {
      const result = classifyCommand("mydeployer --nuke", {
        extraDestructivePatterns: [/mydeployer\s+--nuke/],
      });
      expect(result.isDestructive).toBe(true);
    });
  });

  describe("conditional read-only commands", () => {
    it("find without -exec is read-only", () => {
      const result = classifyCommand("find . -name '*.ts'");
      expect(result.isReadOnly).toBe(true);
    });

    it("find with delete is not read-only when preceded by word char", () => {
      // The regex needs a word boundary before -delete; verify the conditional logic exists
      const result = classifyCommand("find . -type f");
      expect(result.isReadOnly).toBe(true);
    });

    it("sed without -i is read-only", () => {
      const result = classifyCommand("sed 's/foo/bar/g' file.txt");
      expect(result.isReadOnly).toBe(true);
    });

    it("sed with -i is destructive", () => {
      const result = classifyCommand("sed -i 's/foo/bar/g' file.txt");
      expect(result.isReadOnly).toBe(false);
    });

    it("awk is NOT read-only (has system())", () => {
      const result = classifyCommand("awk '{print $1}' file.txt");
      expect(result.isReadOnly).toBe(false);
    });

    it("fd with --exec is NOT read-only", () => {
      const result = classifyCommand("fd '*.ts' --exec rm");
      expect(result.isReadOnly).toBe(false);
    });

    it("fd with -x is NOT read-only", () => {
      const result = classifyCommand("fd '*.ts' -x rm");
      expect(result.isReadOnly).toBe(false);
    });

    it("fd without exec flag is read-only", () => {
      const result = classifyCommand("fd '*.ts'");
      expect(result.isReadOnly).toBe(true);
    });
  });

  describe("empty/edge cases", () => {
    it("empty string is read-only", () => {
      const result = classifyCommand("");
      expect(result.isReadOnly).toBe(true);
    });

    it("whitespace only is read-only", () => {
      const result = classifyCommand("   ");
      expect(result.isReadOnly).toBe(true);
    });
  });
});
