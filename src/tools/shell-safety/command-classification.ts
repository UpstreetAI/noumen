/**
 * Shell command safety classification.
 *
 * Classifies bash commands as read-only or potentially destructive so the
 * permission pipeline can make informed decisions without explicit per-command
 * rules.
 */

import type { CommandClassification, ShellSafetyConfig } from "./types.js";
import { commandWritesGitInternals } from "./git-safety.js";

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
  "pwd",
  "uname",
  "whoami",
  "id",
  "groups",
  "ls",
  "ll",
  "la",
  "dir",
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
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
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
  "jq",
  "yq",
  "xxd",
  "hexdump",
  "od",
  "md5sum",
  "sha256sum",
  "shasum",
  "base64",
  "true",
  "false",
  "test",
  "[",
  "[[",
  "man",
  "help",
  "nproc",
  "arch",
  "lscpu",
  "lsb_release",
  "sw_vers",
  "sysctl",
  "getconf",
]);

// Commands that are read-only only when specific dangerous flags are absent.
// Moved out of READ_ONLY_COMMANDS to enforce flag-level validation.
const CONDITIONAL_READ_ONLY: Record<
  string,
  (command: string, tokens: string[]) => boolean
> = {
  awk: () => false, // awk has system() — never read-only
  sed: (_cmd, tokens) => !tokens.some((t) =>
    t === "-i" || t === "--in-place" ||
    (t.startsWith("-") && !t.startsWith("--") && t.includes("i"))
  ),
  find: (cmd) => !/\b(-exec\b|-execdir\b|-ok\b|-okdir\b|-delete\b|-fprint\b|-fls\b|-fprintf\b)/.test(cmd),
  fd: (_cmd, tokens) => !tokens.some((t) => ["-x", "--exec", "-X", "--exec-batch"].includes(t)),
  fdfind: (_cmd, tokens) => !tokens.some((t) => ["-x", "--exec", "-X", "--exec-batch"].includes(t)),
  date: (_cmd, tokens) => !tokens.some((t) => ["-s", "--set"].includes(t)),
  hostname: (_cmd, tokens) => {
    const positional = tokens.filter((t) => !t.startsWith("-"));
    return positional.length === 0;
  },
  info: (_cmd, tokens) => !tokens.some((t) => ["-o", "--output", "--dribble", "--init-file"].includes(t)),
  tree: (_cmd, tokens) => !tokens.some((t) => t === "-R"),
  dotnet: (_cmd, tokens) => {
    const positional = tokens.filter((t) => !t.startsWith("-"));
    if (positional.length === 0) return true;
    const sub = positional[0];
    return ["--version", "--info", "--list-sdks", "--list-runtimes"].includes(sub)
      || tokens.includes("--version") || tokens.includes("--info")
      || tokens.includes("--list-sdks") || tokens.includes("--list-runtimes");
  },
};

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
  // sed in-place (matches -i anywhere in args, not just first flag)
  /\bsed\b.*\s(-[a-zA-Z]*i[a-zA-Z]*|--in-place)\b/,
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

const SAFE_ECHO_RE = /^(?:echo|printf)(?:\s+(?:'[^']*'|[^|;&`$(){}><#\\!"'\s]+))*(?:\s+2>&1)?\s*$/;

function hasTokenFlag(tokens: string[], ...flags: string[]): boolean {
  return tokens.some((t) => flags.includes(t));
}

/**
 * Split a compound command into individual sub-commands.
 * Handles: `;`, `&&`, `||`, `|`
 *
 * LIMITATION: Does not respect quoted strings — `echo "hello && world"` will
 * be split incorrectly. This is a conservative approximation: the resulting
 * fragments will fail to match the read-only allowlist, so the bias is toward
 * requiring permission (safe default). A proper fix would use a shell parser.
 */
export function splitCompoundCommand(command: string): string[] {
  return command
    .split(/\s*(?:;|&&|\|\||(?<!\|)\|(?!\|))\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const DANGEROUS_ENV_VARS = new Set([
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PATH",
  "PYTHONPATH",
  "NODE_PATH",
  "PERL5LIB",
]);

/**
 * Check whether a command contains dangerous env var prefix assignments.
 * Returns true if any env var in the prefix is in the DANGEROUS_ENV_VARS set.
 */
function hasDangerousEnvVars(command: string): boolean {
  const envPattern = /^[A-Za-z_][A-Za-z0-9_]*(?==)/;
  let cmd = command.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(cmd)) {
    const match = cmd.match(envPattern);
    if (match && DANGEROUS_ENV_VARS.has(match[0])) return true;
    cmd = cmd.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }
  return false;
}

// Zsh builtins that can perform system-level operations
const ZSH_DANGEROUS_COMMANDS = new Set([
  "zmodload",
  "emulate",
  "sysopen",
  "sysread",
  "syswrite",
  "sysseek",
  "zpty",
  "ztcp",
  "zsocket",
  "zf_rm",
  "zf_mv",
  "zf_ln",
  "zf_chmod",
  "zf_chown",
  "zf_mkdir",
  "zf_rmdir",
  "zf_chgrp",
]);

const MAX_SUBCOMMANDS = 50;

/**
 * Detect shell injection patterns that embed arbitrary commands inside
 * otherwise safe-looking commands. Returns a reason string if injection
 * is detected, null otherwise.
 */
export function detectInjectionPatterns(command: string): string | null {
  if (/>\(/.test(command)) return "Output process substitution >(...)";
  if (/=\(/.test(command)) return "Zsh =(...) process substitution";
  if (/\$\{[^}]*[`$]/.test(command)) return "Nested expansion in ${...}";
  if (/[\x00-\x08\x0e-\x1f\x7f]/.test(command)) return "Control character injection";
  // Unicode whitespace that isn't regular space/tab/newline
  if (/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u200B-\u200D\uFEFF]/.test(command)) {
    return "Unicode whitespace injection";
  }
  if (/\w#/.test(command) && !/['"][^'"]*#/.test(command)) {
    const stripped = command.replace(/'[^']*'/g, "").replace(/"[^"]*"/g, "");
    if (/\w#/.test(stripped)) return "Mid-word comment injection";
  }
  if (/\\n/.test(command)) {
    const stripped = command.replace(/'[^']*'/g, "");
    if (/\$'[^']*\\n/.test(stripped)) return "Escaped newline in $'...' string";
  }
  return null;
}

/**
 * Check whether a command contains command substitution or process substitution.
 * These can embed arbitrary commands inside otherwise safe commands.
 */
function hasCommandSubstitution(command: string): boolean {
  return /\$\(/.test(command) || /`[^`]+`/.test(command) || /<\(/.test(command);
}

/**
 * Check whether a command contains unquoted variable expansion (`$VAR`).
 * Variable expansion can smuggle flags or values into otherwise safe commands
 * (e.g. `git diff $Z--output=/tmp/pwned`). We track quote state to allow
 * `$VAR` inside single quotes (where the shell does not expand).
 */
function hasUnquotedExpansion(command: string): boolean {
  let inSingle = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inSingle) { inSingle = true; continue; }
    if (ch === "'" && inSingle) { inSingle = false; continue; }
    if (inSingle) continue;
    if (ch === "\\" && i + 1 < command.length) { i++; continue; }
    if (ch === "$" && i + 1 < command.length) {
      const next = command[i + 1];
      if (next === "(") continue; // handled by hasCommandSubstitution
      if (next === "{" || (next >= "A" && next <= "Z") || (next >= "a" && next <= "z") || next === "_") {
        return true;
      }
    }
  }
  return false;
}

const WRAPPER_COMMANDS = ["sudo", "env", "nohup", "time", "nice", "ionice", "strace", "ltrace", "stdbuf"];
const WRAPPER_WITH_DURATION = new Set(["timeout"]);

/**
 * Phase 1: Strip leading env-var assignments (FOO=bar).
 */
function stripEnvVars(cmd: string): string {
  let result = cmd.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(result)) {
    result = result.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }
  return result;
}

/**
 * Phase 2: Strip leading wrapper commands (sudo, env, nice, etc.) and their flags.
 */
function stripWrappers(cmd: string): string {
  let result = cmd.trim();
  let prev = "";
  while (prev !== result) {
    prev = result;
    for (const prefix of WRAPPER_COMMANDS) {
      if (result.startsWith(prefix + " ")) {
        result = result.slice(prefix.length).trim();
        while (result.startsWith("-")) {
          const spaceIdx = result.indexOf(" ");
          if (spaceIdx === -1) break;
          result = result.slice(spaceIdx).trim();
        }
      }
    }
    for (const prefix of WRAPPER_WITH_DURATION) {
      if (result.startsWith(prefix + " ")) {
        result = result.slice(prefix.length).trim();
        while (result.startsWith("-")) {
          const spaceIdx = result.indexOf(" ");
          if (spaceIdx === -1) break;
          result = result.slice(spaceIdx).trim();
        }
        // Skip the duration/positional argument
        if (result && !result.startsWith("-")) {
          const spaceIdx = result.indexOf(" ");
          if (spaceIdx !== -1) {
            result = result.slice(spaceIdx).trim();
          }
        }
      }
    }
  }
  return result;
}

/**
 * Two-phase prefix stripping: env vars first, then wrappers.
 * Fixed order prevents bypass via interleaved env + wrapper patterns
 * (e.g. `nohup FOO=bar timeout 5 dangerous_cmd`).
 */
function stripPrefixes(command: string): string {
  let cmd = command.trim();
  let prev = "";
  while (prev !== cmd) {
    prev = cmd;
    cmd = stripEnvVars(cmd);
    cmd = stripWrappers(cmd);
  }
  return cmd;
}

export function extractCommandName(command: string): string {
  const cmd = stripPrefixes(command);
  const firstToken = cmd.split(/\s/)[0] ?? "";
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

  // Guard: git -c, --exec-path=, --config-env= enable arbitrary code execution
  // (e.g. git -c core.fsmonitor=malicious.sh status) regardless of subcommand
  if (/\bgit\s+(-c\s|--exec-path=|--config-env=)/.test(command)) {
    return { isReadOnly: false, isDestructive: true, reason: "git config injection vector (-c/--exec-path/--config-env)" };
  }

  // Extract the git subcommand
  const match = command.match(/\bgit\s+(?:--[a-z-]+=?\S*\s+)*([a-z][a-z-]*)/);
  if (!match) {
    return { isReadOnly: false, isDestructive: false, reason: "Cannot parse git subcommand" };
  }
  const subcommand = match[1];

  if (GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) {
    const afterSubcmd = command.slice(command.indexOf(subcommand) + subcommand.length).trim();
    const tokens = afterSubcmd.split(/\s+/).filter(Boolean);
    const positional = tokens.filter((t) => !t.startsWith("-"));
    const flags = tokens.filter((t) => t.startsWith("-"));

    if (subcommand === "branch") {
      if (hasTokenFlag(flags, "--list", "-l")) {
        return { isReadOnly: true, isDestructive: false, reason: "git branch --list is read-only" };
      }
      if (hasTokenFlag(flags, "-d", "-D", "--delete")) {
        return { isReadOnly: false, isDestructive: true, reason: "git branch delete" };
      }
      if (positional.length > 0) {
        return { isReadOnly: false, isDestructive: false, reason: "git branch create" };
      }
    }

    if (subcommand === "tag") {
      if (hasTokenFlag(flags, "-l", "--list")) {
        return { isReadOnly: true, isDestructive: false, reason: "git tag --list is read-only" };
      }
      if (hasTokenFlag(flags, "-d", "-D", "--delete")) {
        return { isReadOnly: false, isDestructive: true, reason: "git tag delete" };
      }
      if (positional.length > 0) {
        return { isReadOnly: false, isDestructive: false, reason: "git tag create" };
      }
    }

    if (subcommand === "stash") {
      const stashSubcmd = positional[0];
      if (stashSubcmd === "list" || stashSubcmd === "show") {
        return { isReadOnly: true, isDestructive: false, reason: `git stash ${stashSubcmd} is read-only` };
      }
      if (stashSubcmd === "drop" || stashSubcmd === "clear") {
        return { isReadOnly: false, isDestructive: true, reason: "git stash destructive operation" };
      }
      return { isReadOnly: false, isDestructive: false, reason: "git stash mutating operation" };
    }

    if (subcommand === "config") {
      if (hasTokenFlag(flags, "--set", "--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section")) {
        return { isReadOnly: false, isDestructive: false, reason: "git config write operation" };
      }
      if (positional.length >= 2) {
        return { isReadOnly: false, isDestructive: false, reason: "git config set key value" };
      }
    }

    if (subcommand === "remote") {
      const remoteSubcmd = positional[0];
      if (remoteSubcmd && ["add", "remove", "rename", "set-url", "set-branches", "prune"].includes(remoteSubcmd)) {
        return { isReadOnly: false, isDestructive: false, reason: "git remote mutating operation" };
      }
    }

    return { isReadOnly: true, isDestructive: false, reason: `git ${subcommand} is read-only` };
  }

  if (GIT_MUTATING_SUBCOMMANDS.has(subcommand)) {
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

  // Injection pattern detection (before any other classification)
  const injectionReason = detectInjectionPatterns(command);
  if (injectionReason) {
    return {
      isReadOnly: false,
      isDestructive: true,
      reason: `Injection detected: ${injectionReason}`,
    };
  }

  // Zsh dangerous builtins
  if (ZSH_DANGEROUS_COMMANDS.has(name)) {
    return {
      isReadOnly: false,
      isDestructive: true,
      reason: `Zsh dangerous command: ${name}`,
    };
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

  // xargs with git: treat as a git command (e.g. xargs git add)
  if (name === "xargs" && /\bgit\b/.test(command)) {
    return classifyGitCommand(command);
  }

  // Commands with command substitution or unquoted variable expansion are never read-only
  if (hasCommandSubstitution(command)) {
    return { isReadOnly: false, isDestructive: false, reason: `Command contains command substitution` };
  }
  if (hasUnquotedExpansion(command)) {
    return { isReadOnly: false, isDestructive: false, reason: `Command contains unquoted variable expansion` };
  }

  // Commands with dangerous env var prefixes are never read-only
  if (hasDangerousEnvVars(command)) {
    return { isReadOnly: false, isDestructive: false, reason: `Command uses dangerous environment variable prefix` };
  }

  if ((name === "echo" || name === "printf") && SAFE_ECHO_RE.test(stripPrefixes(command).trim())) {
    return { isReadOnly: true, isDestructive: false, reason: `${name} with safe arguments is read-only` };
  }

  // Check conditional read-only commands (require flag-level validation)
  const conditionalCheck = CONDITIONAL_READ_ONLY[name];
  if (conditionalCheck) {
    const stripped = stripPrefixes(command).trim();
    const tokens = stripped.split(/\s+/).slice(1);
    if (conditionalCheck(command, tokens)) {
      return { isReadOnly: true, isDestructive: false, reason: `${name} is read-only (flags validated)` };
    }
    return { isReadOnly: false, isDestructive: false, reason: `${name} has potentially dangerous flags` };
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

  if (subCommands.length > MAX_SUBCOMMANDS) {
    return {
      isReadOnly: false,
      isDestructive: false,
      reason: `Too many subcommands (${subCommands.length} > ${MAX_SUBCOMMANDS})`,
    };
  }

  if (subCommands.length > 1) {
    const hasCd = subCommands.some((s) => /^(cd|pushd)\s/.test(s.trim()));
    const hasGit = subCommands.some((s) => {
      const n = extractCommandName(s);
      return n === "git" || (n === "xargs" && /\bgit\b/.test(s));
    });
    if (hasCd && hasGit) {
      return {
        isReadOnly: false,
        isDestructive: false,
        reason: "cd + git compound may escape working directory (bare-repo risk)",
      };
    }

    if (hasGit && commandWritesGitInternals(command)) {
      return {
        isReadOnly: false,
        isDestructive: true,
        reason: "Compound command writes to git internal paths before running git",
      };
    }
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
