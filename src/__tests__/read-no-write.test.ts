import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockFs } from "./helpers.js";
import { SessionStorage } from "../session/storage.js";
import { TaskStore } from "../tasks/store.js";

/**
 * Invariant: read-only operations must not perform writes.
 *
 * Listing / getting / loading should never create directories or files
 * on their own. Creating a store and only calling reads against an empty
 * `VirtualFs` should leave the fs byte-for-byte identical.
 *
 * This used to regress for `SessionStorage.listSessions()` — it called
 * `ensureDir()` up front, so hitting a sessions API on a brand-new world
 * always left an empty `.noumen/sessions/` behind. Same shape for
 * `TaskStore.list` / `get`. These tests pin the behaviour.
 */

describe("SessionStorage — read operations do not write", () => {
  let fs: MockFs;
  let storage: SessionStorage;
  let mkdirSpy: ReturnType<typeof vi.spyOn>;
  let writeFileSpy: ReturnType<typeof vi.spyOn>;
  let appendFileSpy: ReturnType<typeof vi.spyOn>;
  let deleteFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fs = new MockFs();
    storage = new SessionStorage(fs, "/sessions");
    mkdirSpy = vi.spyOn(fs, "mkdir");
    writeFileSpy = vi.spyOn(fs, "writeFile");
    appendFileSpy = vi.spyOn(fs, "appendFile");
    deleteFileSpy = vi.spyOn(fs, "deleteFile");
  });

  function expectNoWrites(): void {
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(appendFileSpy).not.toHaveBeenCalled();
    expect(deleteFileSpy).not.toHaveBeenCalled();
    expect(fs.files.size).toBe(0);
    expect(fs.dirs.size).toBe(0);
  }

  it("constructor alone does not touch the fs", () => {
    expectNoWrites();
  });

  it("listSessions does not create sessionDir when it doesn't exist", async () => {
    const sessions = await storage.listSessions();
    expect(sessions).toEqual([]);
    expect(fs.dirs.has("/sessions")).toBe(false);
    expectNoWrites();
  });

  it("loadMessages on a missing session does not write", async () => {
    const messages = await storage.loadMessages("nonexistent");
    expect(messages).toEqual([]);
    expectNoWrites();
  });

  it("loadAllEntries on a missing session does not write", async () => {
    const entries = await storage.loadAllEntries("nonexistent");
    expect(entries).toEqual([]);
    expectNoWrites();
  });

  it("sessionExists on a missing session does not write", async () => {
    const exists = await storage.sessionExists("nonexistent");
    expect(exists).toBe(false);
    expectNoWrites();
  });

  it("getSessionTitles on a missing session does not write", async () => {
    const titles = await storage.getSessionTitles("nonexistent");
    expect(titles).toEqual({
      title: undefined,
      customTitle: undefined,
      aiTitle: undefined,
    });
    expectNoWrites();
  });

  it("all read-only calls combined still perform zero writes", async () => {
    await storage.listSessions();
    await storage.loadMessages("a");
    await storage.loadAllEntries("b");
    await storage.sessionExists("c");
    await storage.getSessionTitles("d");
    expectNoWrites();
  });

  it("writers still create the sessionDir as needed (sanity)", async () => {
    // Confirm we didn't accidentally break the write path by removing
    // `ensureDir` from reads.
    await storage.appendMessage("s1", { role: "user", content: "hi" });
    expect(fs.dirs.has("/sessions")).toBe(true);
    expect(mkdirSpy).toHaveBeenCalled();
  });
});

describe("TaskStore — read operations do not write", () => {
  let fs: MockFs;
  let store: TaskStore;
  let mkdirSpy: ReturnType<typeof vi.spyOn>;
  let writeFileSpy: ReturnType<typeof vi.spyOn>;
  let appendFileSpy: ReturnType<typeof vi.spyOn>;
  let deleteFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fs = new MockFs();
    store = new TaskStore(fs, "/tasks");
    mkdirSpy = vi.spyOn(fs, "mkdir");
    writeFileSpy = vi.spyOn(fs, "writeFile");
    appendFileSpy = vi.spyOn(fs, "appendFile");
    deleteFileSpy = vi.spyOn(fs, "deleteFile");
  });

  function expectNoWrites(): void {
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(appendFileSpy).not.toHaveBeenCalled();
    expect(deleteFileSpy).not.toHaveBeenCalled();
    expect(fs.files.size).toBe(0);
    expect(fs.dirs.size).toBe(0);
  }

  it("constructor alone does not touch the fs", () => {
    expectNoWrites();
  });

  it("list does not create the tasks dir when it doesn't exist", async () => {
    const tasks = await store.list();
    expect(tasks).toEqual([]);
    expect(fs.dirs.has("/tasks")).toBe(false);
    expectNoWrites();
  });

  it("get on a missing task does not create the tasks dir", async () => {
    const task = await store.get("1");
    expect(task).toBeNull();
    expect(fs.dirs.has("/tasks")).toBe(false);
    expectNoWrites();
  });

  it("all read-only calls combined still perform zero writes", async () => {
    await store.list();
    await store.get("1");
    await store.get("42");
    await store.list();
    expectNoWrites();
  });

  it("create still initializes the tasks dir (sanity)", async () => {
    // Confirm the write path still works after splitting `ensureDir`.
    const task = await store.create({ subject: "hello" });
    expect(task.id).toBe("1");
    expect(fs.dirs.has("/tasks")).toBe(true);
    expect(mkdirSpy).toHaveBeenCalled();
  });

  it("create picks up the correct nextId when tasks pre-exist on disk", async () => {
    // Seed the fs with task 1 and 5 directly, bypassing create().
    await fs.writeFile("/tasks/1.json", JSON.stringify({ id: "1" }));
    await fs.writeFile("/tasks/5.json", JSON.stringify({ id: "5" }));
    mkdirSpy.mockClear();
    writeFileSpy.mockClear();

    const task = await store.create({ subject: "next" });
    expect(task.id).toBe("6");
  });
});
