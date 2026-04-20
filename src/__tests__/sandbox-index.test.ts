import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { loadSandboxId, storeSandboxId } from "../session/sandbox-index.js";

describe("session/sandbox-index", () => {
  let tmpDir: string;
  const sessionDir = ".noumen/sessions";

  beforeEach(async () => {
    tmpDir = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), "noumen-sbidx-"));
  });

  afterEach(async () => {
    await nodeFs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when the index file does not exist", async () => {
    const got = await loadSandboxId(tmpDir, sessionDir, "session-1");
    expect(got).toBeUndefined();
  });

  it("stores and loads a sandbox id", async () => {
    await storeSandboxId(tmpDir, sessionDir, "session-1", "sbx-abc");
    const got = await loadSandboxId(tmpDir, sessionDir, "session-1");
    expect(got).toBe("sbx-abc");
  });

  it("creates the session directory on first write", async () => {
    await storeSandboxId(tmpDir, sessionDir, "session-1", "sbx-abc");
    const indexFile = nodePath.resolve(tmpDir, sessionDir, ".sandbox-index.json");
    const stat = await nodeFs.stat(indexFile);
    expect(stat.isFile()).toBe(true);
  });

  it("preserves entries for other sessions when writing a new one", async () => {
    await storeSandboxId(tmpDir, sessionDir, "session-1", "sbx-one");
    await storeSandboxId(tmpDir, sessionDir, "session-2", "sbx-two");
    expect(await loadSandboxId(tmpDir, sessionDir, "session-1")).toBe("sbx-one");
    expect(await loadSandboxId(tmpDir, sessionDir, "session-2")).toBe("sbx-two");
  });

  it("overwrites the sandbox id for an existing session", async () => {
    await storeSandboxId(tmpDir, sessionDir, "session-1", "sbx-old");
    await storeSandboxId(tmpDir, sessionDir, "session-1", "sbx-new");
    expect(await loadSandboxId(tmpDir, sessionDir, "session-1")).toBe("sbx-new");
  });

  it("returns undefined for a missing session when the file exists", async () => {
    await storeSandboxId(tmpDir, sessionDir, "session-1", "sbx-one");
    const got = await loadSandboxId(tmpDir, sessionDir, "session-missing");
    expect(got).toBeUndefined();
  });

  it("treats a malformed index file as empty on read", async () => {
    const indexFile = nodePath.resolve(tmpDir, sessionDir, ".sandbox-index.json");
    await nodeFs.mkdir(nodePath.dirname(indexFile), { recursive: true });
    await nodeFs.writeFile(indexFile, "{not valid json");
    const got = await loadSandboxId(tmpDir, sessionDir, "session-1");
    expect(got).toBeUndefined();
  });

  it("recovers from a malformed index file on write", async () => {
    const indexFile = nodePath.resolve(tmpDir, sessionDir, ".sandbox-index.json");
    await nodeFs.mkdir(nodePath.dirname(indexFile), { recursive: true });
    await nodeFs.writeFile(indexFile, "{not valid json");
    await storeSandboxId(tmpDir, sessionDir, "session-1", "sbx-recovered");
    const got = await loadSandboxId(tmpDir, sessionDir, "session-1");
    expect(got).toBe("sbx-recovered");
  });
});
