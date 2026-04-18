import { describe, it, expect } from "vitest";
import { MockFs } from "./helpers.js";
import { loadProjectContext, filterActiveContextFiles, activateContextForPaths } from "../context/loader.js";
import { buildProjectContextSection } from "../context/prompts.js";
import { buildSystemPrompt } from "../prompt/system.js";
import type { ContextFile, ProjectContextConfig } from "../context/types.js";

function makeConfig(overrides: Partial<ProjectContextConfig> = {}): ProjectContextConfig {
  return { cwd: "/project", ...overrides };
}

describe("loadProjectContext", () => {
  it("loads NOUMEN.md from project cwd", async () => {
    const fs = new MockFs({
      "/project/NOUMEN.md": "Use TypeScript strict mode.",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("/project/NOUMEN.md");
    expect(files[0].scope).toBe("project");
    expect(files[0].content).toBe("Use TypeScript strict mode.");
  });

  it("loads CLAUDE.md from project cwd", async () => {
    const fs = new MockFs({
      "/project/CLAUDE.md": "Prefer functional style.",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("/project/CLAUDE.md");
    expect(files[0].content).toBe("Prefer functional style.");
  });

  it("loads both NOUMEN.md and CLAUDE.md when both exist", async () => {
    const fs = new MockFs({
      "/project/NOUMEN.md": "Noumen rules.",
      "/project/CLAUDE.md": "Claude rules.",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("/project/NOUMEN.md");
    expect(files[1].path).toBe("/project/CLAUDE.md");
  });

  it("skips CLAUDE.md when dotDirs limits names to .noumen only", async () => {
    const fs = new MockFs({
      "/project/NOUMEN.md": "Noumen only.",
      "/project/CLAUDE.md": "Should be skipped.",
    });
    const files = await loadProjectContext(fs, makeConfig({ dotDirs: { names: [".noumen"] } }));
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("/project/NOUMEN.md");
  });

  it("loads context from a custom dot-dir name", async () => {
    const fs = new MockFs({
      "/project/MINE.md": "mine rules",
      "/project/.mine/MINE.md": "nested mine rules",
    });
    const files = await loadProjectContext(fs, makeConfig({ dotDirs: { names: [".mine"] } }));
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("/project/MINE.md");
    expect(files[1].path).toBe("/project/.mine/MINE.md");
  });

  it("with dotDirs: ['.mine', '.noumen', '.claude'] respects per-layer ordering", async () => {
    const fs = new MockFs({
      "/project/MINE.md": "mine",
      "/project/NOUMEN.md": "noumen",
      "/project/CLAUDE.md": "claude",
    });
    const files = await loadProjectContext(fs, makeConfig({
      dotDirs: { names: [".mine", ".noumen", ".claude"] },
    }));
    expect(files.map((f) => f.content)).toEqual(["mine", "noumen", "claude"]);
  });

  it("maintains hierarchy order: managed < user < project-root < project-cwd < local", async () => {
    const fs = new MockFs({
      "/managed/NOUMEN.md": "managed",
      "/home/.noumen/NOUMEN.md": "user",
      "/NOUMEN.md": "root project",
      "/project/NOUMEN.md": "cwd project",
      "/project/NOUMEN.local.md": "local",
    });
    const files = await loadProjectContext(fs, makeConfig({
      managedDir: "/managed",
      homeDir: "/home",
    }));
    expect(files.map((f) => f.content)).toEqual([
      "managed",
      "user",
      "root project",
      "cwd project",
      "local",
    ]);
    expect(files.map((f) => f.scope)).toEqual([
      "managed",
      "user",
      "project",
      "project",
      "local",
    ]);
  });

  it("loads files from .noumen/ subdirectory", async () => {
    const fs = new MockFs({
      "/project/.noumen/NOUMEN.md": "Dot-dir context.",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("/project/.noumen/NOUMEN.md");
  });

  it("loads files from .claude/ subdirectory", async () => {
    const fs = new MockFs({
      "/project/.claude/CLAUDE.md": "Claude dot-dir.",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("/project/.claude/CLAUDE.md");
  });

  it("loads rules from .noumen/rules/ directory", async () => {
    const fs = new MockFs({
      "/project/.noumen/rules/style.md": "Use 2-space indent.",
      "/project/.noumen/rules/testing.md": "Write unit tests.",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.path).sort()).toEqual([
      "/project/.noumen/rules/style.md",
      "/project/.noumen/rules/testing.md",
    ]);
  });

  it("loads rules from .claude/rules/ directory", async () => {
    const fs = new MockFs({
      "/project/.claude/rules/naming.md": "Use camelCase.",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe("Use camelCase.");
  });

  it("walks ancestor directories from root to cwd", async () => {
    const fs = new MockFs({
      "/NOUMEN.md": "root level",
      "/project/NOUMEN.md": "project level",
      "/project/sub/NOUMEN.md": "sub level",
    });
    const files = await loadProjectContext(fs, makeConfig({ cwd: "/project/sub" }));
    const contents = files.map((f) => f.content);
    expect(contents).toEqual(["root level", "project level", "sub level"]);
  });

  it("silently skips missing files", async () => {
    const fs = new MockFs({});
    const files = await loadProjectContext(fs, makeConfig());
    expect(files).toHaveLength(0);
  });

  it("silently skips empty files", async () => {
    const fs = new MockFs({
      "/project/NOUMEN.md": "   ",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files).toHaveLength(0);
  });

  it("respects loadUserContext: false", async () => {
    const fs = new MockFs({
      "/home/.noumen/NOUMEN.md": "user context",
      "/project/NOUMEN.md": "project context",
    });
    const files = await loadProjectContext(fs, makeConfig({
      homeDir: "/home",
      loadUserContext: false,
    }));
    expect(files).toHaveLength(1);
    expect(files[0].scope).toBe("project");
  });

  it("respects loadProjectContext: false", async () => {
    const fs = new MockFs({
      "/home/.noumen/NOUMEN.md": "user context",
      "/project/NOUMEN.md": "project context",
    });
    const files = await loadProjectContext(fs, makeConfig({
      homeDir: "/home",
      loadProjectContext: false,
    }));
    expect(files).toHaveLength(1);
    expect(files[0].scope).toBe("user");
  });

  it("respects loadLocalContext: false", async () => {
    const fs = new MockFs({
      "/project/NOUMEN.md": "project",
      "/project/NOUMEN.local.md": "local",
    });
    const files = await loadProjectContext(fs, makeConfig({ loadLocalContext: false }));
    expect(files).toHaveLength(1);
    expect(files[0].scope).toBe("project");
  });

  it("excludes files matching exclude patterns", async () => {
    const fs = new MockFs({
      "/project/NOUMEN.md": "keep",
      "/project/.noumen/rules/secret.md": "exclude",
    });
    const files = await loadProjectContext(fs, makeConfig({
      excludes: ["**/secret.md"],
    }));
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("/project/NOUMEN.md");
  });
});

describe("@ includes", () => {
  it("resolves @path references relative to the including file", async () => {
    const fs = new MockFs({
      "/project/NOUMEN.md": "Main doc.\n\nSee @./extra.md for more.",
      "/project/extra.md": "Extra instructions.",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files).toHaveLength(1);
    expect(files[0].includes).toHaveLength(1);
    expect(files[0].includes![0].content).toBe("Extra instructions.");
  });

  it("resolves bare relative @path references", async () => {
    const fs = new MockFs({
      "/project/NOUMEN.md": "Read @docs/guide.md first.",
      "/project/docs/guide.md": "The guide.",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files[0].includes).toHaveLength(1);
    expect(files[0].includes![0].path).toBe("/project/docs/guide.md");
  });

  it("skips @references inside fenced code blocks", async () => {
    const fs = new MockFs({
      "/project/NOUMEN.md": "Example:\n```\n@should-not-include.md\n```\n",
      "/project/should-not-include.md": "Should not appear.",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files[0].includes).toBeUndefined();
  });

  it("skips @references inside inline code spans", async () => {
    const fs = new MockFs({
      "/project/NOUMEN.md": "Use `@path/to/file.md` syntax.",
      "/project/path/to/file.md": "Should not appear.",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files[0].includes).toBeUndefined();
  });

  it("enforces max include depth", async () => {
    const fs = new MockFs({
      "/project/NOUMEN.md": "Start @./a.md",
      "/project/a.md": "A @./b.md",
      "/project/b.md": "B @./c.md",
      "/project/c.md": "C",
    });
    const files = await loadProjectContext(fs, makeConfig({ maxIncludeDepth: 2 }));
    expect(files[0].includes).toHaveLength(1);
    expect(files[0].includes![0].includes).toHaveLength(1);
    // c.md should not be included (depth 2 reached)
    expect(files[0].includes![0].includes![0].includes).toBeUndefined();
  });

  it("detects cycles and stops", async () => {
    const fs = new MockFs({
      "/project/NOUMEN.md": "A @./other.md",
      "/project/other.md": "B @./NOUMEN.md",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files).toHaveLength(1);
    expect(files[0].includes).toHaveLength(1);
    // The cycle back to NOUMEN.md should be skipped
    expect(files[0].includes![0].includes).toBeUndefined();
  });

  it("handles missing included files gracefully", async () => {
    const fs = new MockFs({
      "/project/NOUMEN.md": "See @./nonexistent.md for details.",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files[0].includes).toBeUndefined();
  });
});

describe("frontmatter and conditional rules", () => {
  it("parses paths frontmatter into globs", async () => {
    const fs = new MockFs({
      "/project/.noumen/rules/react.md": "---\npaths: src/**/*.tsx\n---\nUse React best practices.",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files).toHaveLength(1);
    expect(files[0].globs).toEqual(["src/**/*.tsx"]);
  });

  it("strips frontmatter from content", async () => {
    const fs = new MockFs({
      "/project/NOUMEN.md": "---\ndescription: test\n---\nActual content.",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files[0].content).toBe("Actual content.");
  });

  it("strips HTML comments from content", async () => {
    const fs = new MockFs({
      "/project/NOUMEN.md": "Before <!-- hidden --> After",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files[0].content).toBe("Before  After");
  });
});

describe("filterActiveContextFiles", () => {
  const unconditional: ContextFile = {
    path: "/project/NOUMEN.md",
    scope: "project",
    content: "Always active.",
  };

  const conditional: ContextFile = {
    path: "/project/.noumen/rules/react.md",
    scope: "project",
    content: "React rules.",
    globs: ["src/**/*.tsx"],
  };

  it("always includes files without globs", () => {
    const result = filterActiveContextFiles([unconditional], [], "/project");
    expect(result).toHaveLength(1);
  });

  it("excludes conditional files when no matching paths", () => {
    const result = filterActiveContextFiles(
      [unconditional, conditional],
      ["/project/README.md"],
      "/project",
    );
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/project/NOUMEN.md");
  });

  it("includes conditional files when paths match globs", () => {
    const result = filterActiveContextFiles(
      [unconditional, conditional],
      ["/project/src/App.tsx"],
      "/project",
    );
    expect(result).toHaveLength(2);
  });
});

describe("activateContextForPaths", () => {
  it("returns newly activated file paths", () => {
    const files: ContextFile[] = [
      { path: "/rules/ts.md", scope: "project", content: "TS", globs: ["**/*.ts"] },
      { path: "/rules/css.md", scope: "project", content: "CSS", globs: ["**/*.css"] },
    ];
    const activated = new Set<string>();
    const result = activateContextForPaths(files, ["/project/src/app.ts"], "/project", activated);
    expect(result).toEqual(["/rules/ts.md"]);
    expect(activated.has("/rules/ts.md")).toBe(true);
    expect(activated.has("/rules/css.md")).toBe(false);
  });

  it("does not re-activate already activated files", () => {
    const files: ContextFile[] = [
      { path: "/rules/ts.md", scope: "project", content: "TS", globs: ["**/*.ts"] },
    ];
    const activated = new Set<string>(["/rules/ts.md"]);
    const result = activateContextForPaths(files, ["/project/src/app.ts"], "/project", activated);
    expect(result).toEqual([]);
  });

  it("skips unconditional files", () => {
    const files: ContextFile[] = [
      { path: "/rules/general.md", scope: "project", content: "General" },
    ];
    const activated = new Set<string>();
    const result = activateContextForPaths(files, ["/project/src/app.ts"], "/project", activated);
    expect(result).toEqual([]);
  });
});

describe("buildProjectContextSection", () => {
  it("formats files with scope labels", () => {
    const files: ContextFile[] = [
      { path: "/project/NOUMEN.md", scope: "project", content: "Project rules." },
    ];
    const result = buildProjectContextSection(files);
    expect(result).toContain("Contents of /project/NOUMEN.md (project instructions)");
    expect(result).toContain("Project rules.");
    expect(result).toContain("project instructions customize your behavior");
  });

  it("renders multiple files in order", () => {
    const files: ContextFile[] = [
      { path: "/managed/NOUMEN.md", scope: "managed", content: "Managed." },
      { path: "/project/NOUMEN.md", scope: "project", content: "Project." },
      { path: "/project/NOUMEN.local.md", scope: "local", content: "Local." },
    ];
    const result = buildProjectContextSection(files);
    const managedIdx = result.indexOf("(managed instructions)");
    const projectIdx = result.indexOf("(project instructions)");
    const localIdx = result.indexOf("(local instructions)");
    expect(managedIdx).toBeLessThan(projectIdx);
    expect(projectIdx).toBeLessThan(localIdx);
  });

  it("filters by scope when filter is provided", () => {
    const files: ContextFile[] = [
      { path: "/managed/NOUMEN.md", scope: "managed", content: "Managed." },
      { path: "/project/NOUMEN.md", scope: "project", content: "Project." },
    ];
    const result = buildProjectContextSection(files, ["project"]);
    expect(result).toContain("Project.");
    expect(result).not.toContain("Managed.");
  });

  it("returns empty string when no files match", () => {
    const result = buildProjectContextSection([]);
    expect(result).toBe("");
  });

  it("renders included files after their parent", () => {
    const files: ContextFile[] = [
      {
        path: "/project/NOUMEN.md",
        scope: "project",
        content: "Parent.",
        includes: [
          { path: "/project/extra.md", scope: "project", content: "Included." },
        ],
      },
    ];
    const result = buildProjectContextSection(files);
    const parentIdx = result.indexOf("Contents of /project/NOUMEN.md");
    const childIdx = result.indexOf("Contents of /project/extra.md");
    expect(parentIdx).toBeLessThan(childIdx);
  });
});

describe("buildSystemPrompt integration", () => {
  it("includes projectContext section in system prompt", () => {
    const result = buildSystemPrompt({
      projectContext: "# Project\nUse TypeScript.",
      date: "Monday, January 1, 2024",
    });
    expect(result).toContain("# Project\nUse TypeScript.");
    expect(result).toContain("Today's date is Monday, January 1, 2024.");
  });

  it("places projectContext after date and before memory", () => {
    const result = buildSystemPrompt({
      projectContext: "PROJECT_CONTEXT_MARKER",
      memorySection: "MEMORY_SECTION_MARKER",
      date: "Monday, January 1, 2024",
    });
    const dateIdx = result.indexOf("Today's date");
    const projectIdx = result.indexOf("PROJECT_CONTEXT_MARKER");
    const memoryIdx = result.indexOf("MEMORY_SECTION_MARKER");
    expect(dateIdx).toBeLessThan(projectIdx);
    expect(projectIdx).toBeLessThan(memoryIdx);
  });

  it("omits projectContext when not provided", () => {
    const result = buildSystemPrompt({
      date: "Monday, January 1, 2024",
    });
    expect(result).not.toContain("project instructions");
  });
});

describe("recursive rules directory scanning", () => {
  it("scans nested subdirectories in rules", async () => {
    const fs = new MockFs({
      "/project/.noumen/rules/general/style.md": "Style rules.",
      "/project/.noumen/rules/general/naming.md": "Naming rules.",
      "/project/.noumen/rules/testing/unit.md": "Unit test rules.",
    });
    const files = await loadProjectContext(fs, makeConfig());
    expect(files).toHaveLength(3);
  });
});

describe("managed layer", () => {
  it("loads from managedDir when provided", async () => {
    const fs = new MockFs({
      "/etc/noumen/NOUMEN.md": "Enterprise policy.",
    });
    const files = await loadProjectContext(fs, makeConfig({
      managedDir: "/etc/noumen",
    }));
    expect(files).toHaveLength(1);
    expect(files[0].scope).toBe("managed");
    expect(files[0].content).toBe("Enterprise policy.");
  });

  it("loads managed rules", async () => {
    const fs = new MockFs({
      "/etc/noumen/.noumen/rules/security.md": "Security policy.",
    });
    const files = await loadProjectContext(fs, makeConfig({
      managedDir: "/etc/noumen",
    }));
    expect(files).toHaveLength(1);
    expect(files[0].scope).toBe("managed");
  });
});

describe("user layer", () => {
  it("loads from homeDir/.noumen/", async () => {
    const fs = new MockFs({
      "/home/user/.noumen/NOUMEN.md": "Personal preferences.",
    });
    const files = await loadProjectContext(fs, makeConfig({
      homeDir: "/home/user",
    }));
    expect(files).toHaveLength(1);
    expect(files[0].scope).toBe("user");
  });

  it("loads from homeDir/.claude/ for compatibility", async () => {
    const fs = new MockFs({
      "/home/user/.claude/CLAUDE.md": "Claude preferences.",
    });
    const files = await loadProjectContext(fs, makeConfig({
      homeDir: "/home/user",
    }));
    expect(files).toHaveLength(1);
    expect(files[0].scope).toBe("user");
    expect(files[0].path).toBe("/home/user/.claude/CLAUDE.md");
  });

  it("loads user rules from homeDir/.noumen/rules/", async () => {
    const fs = new MockFs({
      "/home/user/.noumen/rules/prefs.md": "My preferences.",
    });
    const files = await loadProjectContext(fs, makeConfig({
      homeDir: "/home/user",
    }));
    expect(files).toHaveLength(1);
    expect(files[0].scope).toBe("user");
  });
});
