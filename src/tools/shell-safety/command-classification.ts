/**
 * Shell command safety classification.
 *
 * Classifies bash commands as read-only or potentially destructive so the
 * permission pipeline can make informed decisions without explicit per-command
 * rules.
 */

import type { CommandClassification, ShellSafetyConfig } from "./types.js";

// -- Read-only commands: always safe, never modify state --

const READ_ONLY_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "file",
  "which",
  "whence",
  "where",
  "whereis",
  "type",
  "echo",
  "printf",
  "pwd",
  "env",
  "printenv",
  "date",
  "uname",
  "hostname",
  "whoami",
  "id",
  "groups",
  "ls",
  "ll",
  "la",
  "dir",
  "tree",
  "stat",
  "du",
  "df",
  "free",
  "uptime",
  "ps",
  "top",
  "htop",
  "lsof",
  "ss",
  "netstat",
  "ifconfig",
  "ip",
  "ping",
  "dig",
  "nslookup",
  "host",
  "traceroute",
  "curl", // mostly read, but can POST — classified as read-only for agent use
  "wget",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "find",
  "fd",
  "fdfind",
  "locate",
  "readlink",
  "realpath",
  "basename",
  "dirname",
  "diff",
  "comm",
  "sort",
  "uniq",
  "cut",
  "tr",
  "awk",
  "sed", // sed -i is destructive but caught by destructive patterns
  "jq",
  "yq",
  "xxd",
  "hexdump",
  "od",
  "md5sum",
  "sha256sum",
  "shasum",
  "base64",
  "tee",
  "xargs",
  "true",
  "false",
  "test",
  "[",
  "[[",
  "man",
  "help",
  "info",
  "nproc",
  "arch",
  "lscpu",
  "lsb_release",
  "sw_vers",
  "sysctl",
  "getconf",
  "dotnet", // dotnet --info, dotnet --list-sdks
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
  "java",
  "go",
  "rustc",
  "cargo",
]);

// -- Git read-only subcommands --

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "shortlog",
  "describe",
  "rev-parse",
  "rev-list",
  "cat-file",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "name-rev",
  "for-each-ref",
  "count-objects",
  "fsck",
  "verify-pack",
  "reflog",
  "stash",    // "stash list" / "stash show" — stash apply/pop are not here
  "tag",      // "tag -l" is safe; "tag <name>" creates — caught below
  "branch",   // "branch --list" is safe; "branch <name>" creates — caught below
  "remote",   // "remote -v" safe; "remote add/remove" — caught below
  "config",   // "config --list/--get" safe
  "help",
  "version",
  "--version",
  "--help",
]);

// Subcommands of git that are always mutating when used
const GIT_MUTATING_SUBCOMMANDS = new Set([
  "push",
  "pull",
  "fetch",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "commit",
  "add",
  "rm",
  "mv",
  "init",
  "clone",
  "checkout",
  "switch",
  "restore",
  "reset",
  "clean",
  "bisect",
  "am",
  "apply",
  "format-patch",
  "submodule",
  "worktree",
]);

// -- Destructive patterns: commands that can cause irreversible damage --

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // rm -rf / rm -r / rm --recursive (but not plain rm single-file)
  /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/,
  // rm on root-like paths
  /\brm\s+.*\s+\/($|\s)/,
  // git force operations
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+.*-[a-zA-Z]*f/,
  /\bgit\s+checkout\s+--\s+\./,
  // Filesystem destruction
  /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*|--recursive)\s+777\b/,
  /\bchown\s+(-[a-zA-Z]*R[a-zA-Z]*|--recursive)\b/,
  /\bdd\s+/,
  /\bmkfs\b/,
  /\bformat\b/,
  /\bfdisk\b/,
  // Dangerous redirects
  />\s*\/dev\/sd[a-z]/,
  // Database destructive operations
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bDELETE\s+FROM\b/i,
  // sed in-place
  /\bsed\s+(-[a-zA-Z]*i[a-zA-Z]*|--in-place)\b/,
  // Container/system destruction
  /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/,
  /\bkubectl\s+delete\b/,
  // Kill processes
  /\bkill\s+-9\b/,
  /\bkillall\b/,
  /\bpkill\b/,
  // Recursive operations on root
  /\bfind\s+\/\s+.*-delete\b/,
  /\bfind\s+\/\s+.*-exec\s+rm\b/,
];

/**
 * Split a compound command into individual sub-commands.
 * Handles: `;`, `&&`, `||`, `|`
 * Does NOT handle quoted strings containing these operators — a conservative
 * approximation that biases toward classifying as non-read-only (safe default).
 */
function splitCompoundCommand(command: string): string[] {
  return command
    .split(/\s*(?:;|&&|\|\||(?<!\|)\|(?!\|))\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Extract the base command name from a command string (first token after
 * env vars and redirects).
 */
function extractCommandName(command: string): string {
  let cmd = command.trim();
  // Strip leading env-var assignments: FOO=bar BAZ=qux command ...
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(cmd)) {
    cmd = cmd.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }
  // Strip sudo/env/nohup/time prefixes
  for (const prefix of ["sudo", "env", "nohup", "time", "nice", "ionice", "strace", "ltrace"]) {
    if (cmd.startsWith(prefix + " ")) {
      cmd = cmd.slice(prefix.length).trim();
      // Strip flags of the prefix command
      while (cmd.startsWith("-")) {
        const spaceIdx = cmd.indexOf(" ");
        if (spaceIdx === -1) break;
        cmd = cmd.slice(spaceIdx).trim();
      }
      // Strip env-var assignments that follow the prefix (e.g. env FOO=bar cmd)
      while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(cmd)) {
        cmd = cmd.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
      }
    }
  }
  const firstToken = cmd.split(/\s/)[0] ?? "";
  // Resolve paths: /usr/bin/ls -> ls
  const base = firstToken.includes("/") ? firstToken.split("/").pop()! : firstToken;
  return base;
}

function classifyGitCommand(command: string): CommandClassification {
  // Handle git --version / git --help directly
  if (/\bgit\s+--version\b/.test(command)) {
    return { isReadOnly: true, isDestructive: false, reason: "git --version is read-only" };
  }
  if (/\bgit\s+--help\b/.test(command)) {
    return { isReadOnly: true, isDestructive: false, reason: "git --help is read-only" };
  }

  // Extract the git subcommand
  const match = command.match(/\bgit\s+(?:--[a-z-]+=?\S*\s+)*([a-z][a-z-]*)/);
  if (!match) {
    return { isReadOnly: false, isDestructive: false, reason: "Cannot parse git subcommand" };
  }
  const subcommand = match[1];

  if (GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) {
    // Some "read-only" subcommands become mutating with certain args
    if (subcommand === "branch" && !command.includes("--list") && !command.includes("-l")) {
      if (command.includes("-d") || command.includes("-D") || command.includes("--delete")) {
        return { isReadOnly: false, isDestructive: true, reason: "git branch delete" };
      }
      const afterBranch = command.slice(command.indexOf("branch") + 6).trim();
      const tokens = afterBranch.split(/\s+/).filter((t) => t && !t.startsWith("-"));
      if (tokens.length > 0) {
        return { isReadOnly: false, isDestructive: false, reason: "git branch create" };
      }
      // No positional args = listing branches (read-only)
    }
    if (subcommand === "tag" && !command.includes("-l") && !command.includes("--list")) {
      const afterTag = command.slice(command.indexOf("tag") + 3).trim();
      const tokens = afterTag.split(/\s+/).filter((t) => !t.startsWith("-"));
      if (tokens.length > 0) {
        return { isReadOnly: false, isDestructive: false, reason: "git tag create" };
      }
    }
    if (subcommand === "stash") {
      if (command.includes("pop") || command.includes("apply") || command.includes("drop") || command.includes("clear")) {
        return { isReadOnly: false, isDestructive: false, reason: "git stash mutating operation" };
      }
    }

    return { isReadOnly: true, isDestructive: false, reason: `git ${subcommand} is read-only` };
  }

  if (GIT_MUTATING_SUBCOMMANDS.has(subcommand)) {
    // Check destructive patterns
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(command)) {
        return { isReadOnly: false, isDestructive: true, reason: `Destructive: ${pattern.source}` };
      }
    }
    return { isReadOnly: false, isDestructive: false, reason: `git ${subcommand} is mutating` };
  }

  return { isReadOnly: false, isDestructive: false, reason: `Unknown git subcommand: ${subcommand}` };
}

/**
 * Classify a single (non-compound) command.
 */
function classifySingleCommand(
  command: string,
  config?: ShellSafetyConfig,
): CommandClassification {
  const name = extractCommandName(command);

  if (!name) {
    return { isReadOnly: false, isDestructive: false, reason: "Empty command" };
  }

  // Check destructive patterns first
  const allDestructive = [
    ...DESTRUCTIVE_PATTERNS,
    ...(config?.extraDestructivePatterns ?? []),
  ];
  for (const pattern of allDestructive) {
    if (pattern.test(command)) {
      return {
        isReadOnly: false,
        isDestructive: true,
        reason: `Matches destructive pattern: ${pattern.source}`,
      };
    }
  }

  // Git has its own classification
  if (name === "git") {
    return classifyGitCommand(command);
  }

  // Check against read-only allowlist
  const extraReadOnly = new Set(config?.extraReadOnlyCommands ?? []);
  if (READ_ONLY_COMMANDS.has(name) || extraReadOnly.has(name)) {
    return { isReadOnly: true, isDestructive: false, reason: `${name} is read-only` };
  }

  // Default: not read-only, not destructive
  return {
    isReadOnly: false,
    isDestructive: false,
    reason: `${name} is not in the read-only allowlist`,
  };
}

/**
 * Classify a shell command (potentially compound with pipes/chains).
 *
 * - A compound command is read-only only if ALL sub-commands are read-only.
 * - A compound command is destructive if ANY sub-command is destructive.
 */
export function classifyCommand(
  command: string,
  config?: ShellSafetyConfig,
): CommandClassification {
  if (!command.trim()) {
    return { isReadOnly: true, isDestructive: false, reason: "Empty command" };
  }

  const subCommands = splitCompoundCommand(command);
  if (subCommands.length === 0) {
    return { isReadOnly: true, isDestructive: false, reason: "Empty command" };
  }

  let allReadOnly = true;
  let anyDestructive = false;
  const reasons: string[] = [];

  for (const sub of subCommands) {
    const result = classifySingleCommand(sub, config);
    if (!result.isReadOnly) allReadOnly = false;
    if (result.isDestructive) anyDestructive = true;
    if (result.reason) reasons.push(result.reason);
  }

  return {
    isReadOnly: allReadOnly,
    isDestructive: anyDestructive,
    reason: reasons.join("; "),
  };
}
