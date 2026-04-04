import { describe, it, expect } from "vitest";
import { truncateIndex, FileMemoryProvider } from "../memory/file-provider.js";
import { MockFs } from "./helpers.js";

describe("truncateIndex", () => {
  it("does not truncate small content", () => {
    const raw = "hello\nworld";
    const out = truncateIndex(raw, 200, 25_000);
    expect(out.content).toBe(raw);
    expect(out.lineCount).toBe(2);
    expect(out.byteCount).toBe(raw.length);
    expect(out.wasLineTruncated).toBe(false);
    expect(out.wasByteTruncated).toBe(false);
  });

  it("truncates by line count", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `L${i}`);
    const raw = lines.join("\n");
    const out = truncateIndex(raw, 4, 1_000_000);
    expect(out.wasLineTruncated).toBe(true);
    expect(out.wasByteTruncated).toBe(false);
    expect(out.content.startsWith("L0\nL1\nL2\nL3")).toBe(true);
    expect(out.content).toContain("WARNING:");
    expect(out.content).toContain("10 lines (limit: 4)");
  });

  it("truncates by byte count", () => {
    const raw = "x".repeat(100);
    const out = truncateIndex(raw, 500, 40);
    expect(out.wasByteTruncated).toBe(true);
    expect(out.wasLineTruncated).toBe(false);
    expect(out.content.length).toBeLessThanOrEqual(raw.length + 200);
    expect(out.content).toContain("WARNING:");
    expect(out.content).toContain("bytes");
  });

  it("applies combined line and byte truncation", () => {
    const longLine = "y".repeat(50);
    const raw = Array.from({ length: 8 }, () => longLine).join("\n");
    const out = truncateIndex(raw, 5, 80);
    expect(out.wasLineTruncated).toBe(true);
    expect(out.wasByteTruncated).toBe(true);
    expect(out.content).toContain("WARNING:");
    expect(out.content).toContain("lines and");
    expect(out.content).toContain("bytes");
  });

  it("appends warning when truncated", () => {
    const out = truncateIndex("a\nb\nc\nd\ne", 3, 25_000);
    expect(out.content).toContain("\n\n> WARNING:");
    expect(out.content).toContain("MEMORY.md");
  });
});

describe("FileMemoryProvider", () => {
  it("loadIndex returns empty string when index is missing", async () => {
    const fs = new MockFs();
    const p = new FileMemoryProvider(fs, "mem");
    await expect(p.loadIndex()).resolves.toBe("");
  });

  it("saveEntry creates file and rebuilds index", async () => {
    const fs = new MockFs();
    const p = new FileMemoryProvider(fs, "mem");
    await p.saveEntry({
      name: "Alpha Topic",
      description: "desc",
      type: "user",
      content: "body",
    });
    expect(fs.files.has("mem/alpha_topic.md")).toBe(true);
    const index = await fs.readFile("mem/MEMORY.md");
    expect(index).toContain("[Alpha Topic](alpha_topic.md)");
    expect(index).toContain("— desc");
    const loaded = await p.loadIndex();
    expect(loaded).toContain("[Alpha Topic](alpha_topic.md)");
  });

  it("loadEntry parses frontmatter", async () => {
    const fs = new MockFs({
      "mem/note.md": `---
name: My Note
description: short
type: reference
---

Hello content`,
    });
    const p = new FileMemoryProvider(fs, "mem");
    const entry = await p.loadEntry("note.md");
    expect(entry).toMatchObject({
      name: "My Note",
      description: "short",
      type: "reference",
      path: "note.md",
    });
    expect(entry?.content.trim()).toBe("Hello content");
  });

  it("removeEntry deletes file and updates index", async () => {
    const fs = new MockFs();
    const p = new FileMemoryProvider(fs, "mem");
    await p.saveEntry({
      name: "ToRemove",
      description: "",
      type: "project",
      content: "x",
      path: "gone.md",
    });
    expect(fs.files.has("mem/gone.md")).toBe(true);
    await p.removeEntry("gone.md");
    expect(fs.files.has("mem/gone.md")).toBe(false);
    const index = await fs.readFile("mem/MEMORY.md");
    expect(index).not.toContain("ToRemove");
  });

  it("listEntries lists .md files excluding MEMORY.md", async () => {
    const fs = new MockFs({
      "mem/a.md": "---\nname: A\ndescription: \ntype: user\n---\n",
      "mem/b.md": "---\nname: B\ndescription: \ntype: project\n---\n",
      "mem/MEMORY.md": "- ignore\n",
      "mem/other.txt": "x",
    });
    const p = new FileMemoryProvider(fs, "mem");
    const list = await p.listEntries();
    const names = list.map((e) => e.name).sort();
    expect(names).toEqual(["A", "B"]);
  });

  it("search filters by keyword in name, description, or content", async () => {
    const fs = new MockFs();
    const p = new FileMemoryProvider(fs, "mem");
    await p.saveEntry({
      name: "Redis Cache",
      description: "stores keys",
      type: "reference",
      content: "nothing special",
    });
    await p.saveEntry({
      name: "Other",
      description: "unrelated",
      type: "project",
      content: "uses redis client",
    });
    const byName = await p.search("redis");
    expect(byName.map((e) => e.name).sort()).toEqual(["Other", "Redis Cache"]);
    const byDesc = await p.search("keys");
    expect(byDesc.map((e) => e.name)).toEqual(["Redis Cache"]);
    const byBody = await p.search("client");
    expect(byBody.map((e) => e.name)).toEqual(["Other"]);
  });
});
