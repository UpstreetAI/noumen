import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  parseAllowedTools,
  parsePaths,
} from "../skills/frontmatter.js";

describe("parseFrontmatter", () => {
  it("returns empty frontmatter and full body when no frontmatter present", () => {
    const result = parseFrontmatter("# Hello\nSome content");
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("# Hello\nSome content");
  });

  it("parses simple key-value pairs", () => {
    const md = `---
description: A test skill
context: fork
---
Body here.`;
    const result = parseFrontmatter(md);
    expect(result.frontmatter.description).toBe("A test skill");
    expect(result.frontmatter.context).toBe("fork");
    expect(result.body).toBe("Body here.");
  });

  it("parses allowed-tools as comma-separated string", () => {
    const md = `---
allowed-tools: Bash, ReadFile, WriteFile
---
Body.`;
    const result = parseFrontmatter(md);
    expect(result.frontmatter["allowed-tools"]).toBe("Bash, ReadFile, WriteFile");
  });

  it("parses allowed-tools as inline array", () => {
    const md = `---
allowed-tools: [Bash, ReadFile]
---
Body.`;
    const result = parseFrontmatter(md);
    expect(result.frontmatter["allowed-tools"]).toEqual(["Bash", "ReadFile"]);
  });

  it("parses allowed-tools as YAML list", () => {
    const md = `---
allowed-tools:
  - Bash
  - ReadFile
  - WriteFile
---
Body.`;
    const result = parseFrontmatter(md);
    expect(result.frontmatter["allowed-tools"]).toEqual(["Bash", "ReadFile", "WriteFile"]);
  });

  it("parses paths field", () => {
    const md = `---
paths: "*.ts, src/**/*.tsx"
---
Body.`;
    const result = parseFrontmatter(md);
    expect(result.frontmatter.paths).toBe("*.ts, src/**/*.tsx");
  });

  it("parses argument-hint", () => {
    const md = `---
argument-hint: "<prompt>"
---
Body.`;
    const result = parseFrontmatter(md);
    expect(result.frontmatter["argument-hint"]).toBe("<prompt>");
  });

  it("handles frontmatter with special YAML characters via retry", () => {
    const md = `---
paths: **/*.{ts,tsx}
---
Body.`;
    const result = parseFrontmatter(md);
    expect(result.frontmatter.paths).toBe("**/*.{ts,tsx}");
    expect(result.body).toBe("Body.");
  });

  it("preserves body content exactly after frontmatter", () => {
    const md = `---
description: Test
---
# Title

Paragraph one.

Paragraph two.`;
    const result = parseFrontmatter(md);
    expect(result.body).toBe("# Title\n\nParagraph one.\n\nParagraph two.");
  });
});

describe("parseAllowedTools", () => {
  it("returns empty array for null/undefined", () => {
    expect(parseAllowedTools(null)).toEqual([]);
    expect(parseAllowedTools(undefined)).toEqual([]);
  });

  it("splits comma-separated string", () => {
    expect(parseAllowedTools("Bash, ReadFile")).toEqual(["Bash", "ReadFile"]);
  });

  it("passes through array", () => {
    expect(parseAllowedTools(["Bash", "ReadFile"])).toEqual(["Bash", "ReadFile"]);
  });

  it("filters empty entries", () => {
    expect(parseAllowedTools("Bash,,ReadFile")).toEqual(["Bash", "ReadFile"]);
  });
});

describe("parsePaths", () => {
  it("returns empty array for null/undefined", () => {
    expect(parsePaths(null)).toEqual([]);
    expect(parsePaths(undefined)).toEqual([]);
  });

  it("splits comma-separated string", () => {
    expect(parsePaths("*.ts, src/**")).toEqual(["*.ts", "src/**"]);
  });

  it("passes through array", () => {
    expect(parsePaths(["*.ts", "src/**"])).toEqual(["*.ts", "src/**"]);
  });
});
