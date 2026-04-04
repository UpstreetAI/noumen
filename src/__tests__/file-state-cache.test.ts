import { describe, it, expect } from "vitest";
import { FileStateCache } from "../file-state/cache.js";

describe("FileStateCache", () => {
  it("stores and retrieves file state by path", () => {
    const cache = new FileStateCache();
    cache.set("/foo/bar.ts", { content: "hello", timestamp: 1000, offset: 1, limit: 10 });

    const state = cache.get("/foo/bar.ts");
    expect(state).toBeDefined();
    expect(state!.content).toBe("hello");
    expect(state!.timestamp).toBe(1000);
    expect(state!.offset).toBe(1);
    expect(state!.limit).toBe(10);
  });

  it("returns undefined for unknown paths", () => {
    const cache = new FileStateCache();
    expect(cache.get("/unknown")).toBeUndefined();
    expect(cache.has("/unknown")).toBe(false);
  });

  it("overwrites existing entry for same path", () => {
    const cache = new FileStateCache();
    cache.set("/a.ts", { content: "v1", timestamp: 100 });
    cache.set("/a.ts", { content: "v2", timestamp: 200 });
    expect(cache.get("/a.ts")!.content).toBe("v2");
    expect(cache.size).toBe(1);
  });

  it("evicts oldest entry when maxEntries exceeded", () => {
    const cache = new FileStateCache({ maxEntries: 2, maxBytes: 100_000_000 });
    cache.set("/a.ts", { content: "a", timestamp: 1 });
    cache.set("/b.ts", { content: "b", timestamp: 2 });
    cache.set("/c.ts", { content: "c", timestamp: 3 });

    expect(cache.has("/a.ts")).toBe(false);
    expect(cache.has("/b.ts")).toBe(true);
    expect(cache.has("/c.ts")).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("evicts oldest entry when maxBytes exceeded", () => {
    const cache = new FileStateCache({ maxEntries: 100, maxBytes: 10 });
    cache.set("/a.ts", { content: "12345", timestamp: 1 }); // 5 bytes
    cache.set("/b.ts", { content: "12345678", timestamp: 2 }); // 8 bytes, evicts a

    expect(cache.has("/a.ts")).toBe(false);
    expect(cache.has("/b.ts")).toBe(true);
  });

  it("touching via get() moves entry to MRU position", () => {
    const cache = new FileStateCache({ maxEntries: 2, maxBytes: 100_000_000 });
    cache.set("/a.ts", { content: "a", timestamp: 1 });
    cache.set("/b.ts", { content: "b", timestamp: 2 });

    // Touch a so b becomes the oldest
    cache.get("/a.ts");
    cache.set("/c.ts", { content: "c", timestamp: 3 });

    expect(cache.has("/a.ts")).toBe(true);
    expect(cache.has("/b.ts")).toBe(false);
    expect(cache.has("/c.ts")).toBe(true);
  });

  it("delete removes an entry and frees bytes", () => {
    const cache = new FileStateCache();
    cache.set("/a.ts", { content: "hello", timestamp: 1 });
    const before = cache.totalBytes;
    cache.delete("/a.ts");
    expect(cache.has("/a.ts")).toBe(false);
    expect(cache.totalBytes).toBeLessThan(before);
    expect(cache.size).toBe(0);
  });

  it("clear removes all entries", () => {
    const cache = new FileStateCache();
    cache.set("/a.ts", { content: "a", timestamp: 1 });
    cache.set("/b.ts", { content: "b", timestamp: 2 });
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.totalBytes).toBe(0);
  });

  it("post-edit cache entry has no offset/limit", () => {
    const cache = new FileStateCache();
    cache.set("/a.ts", { content: "full content after edit", timestamp: 500 });

    const state = cache.get("/a.ts");
    expect(state!.offset).toBeUndefined();
    expect(state!.limit).toBeUndefined();
  });
});
