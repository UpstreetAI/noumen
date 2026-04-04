import { describe, it, expect, beforeEach } from "vitest";
import { MockFs } from "./helpers.js";
import { FileCheckpointManager } from "../checkpoint/manager.js";
import type { CheckpointConfig } from "../checkpoint/types.js";

let fs: MockFs;
let manager: FileCheckpointManager;
const sessionId = "test-session";

const config: CheckpointConfig = {
  enabled: true,
  maxSnapshots: 5,
  backupDir: ".backups",
};

beforeEach(() => {
  fs = new MockFs();
  manager = new FileCheckpointManager(fs, config);
});

describe("FileCheckpointManager", () => {
  it("makeSnapshot creates an empty snapshot when no files tracked", async () => {
    await manager.makeSnapshot("msg-1", sessionId);
    const state = manager.getState();
    expect(state.snapshots).toHaveLength(1);
    expect(state.snapshots[0].messageId).toBe("msg-1");
    expect(Object.keys(state.snapshots[0].trackedFileBackups)).toHaveLength(0);
    expect(state.snapshotSequence).toBe(1);
  });

  it("trackEdit creates v1 backup before mutation", async () => {
    fs.files.set("/src/app.ts", "original content");

    await manager.makeSnapshot("msg-1", sessionId);
    await manager.trackEdit("/src/app.ts", "msg-1", sessionId);

    const state = manager.getState();
    expect(state.trackedFiles.has("/src/app.ts")).toBe(true);

    const backup = state.snapshots[0].trackedFileBackups["/src/app.ts"];
    expect(backup).toBeDefined();
    expect(backup.version).toBe(1);
    expect(backup.backupFileName).not.toBeNull();

    const backupContent = await fs.readFile(
      `.backups/${sessionId}/${backup.backupFileName}`,
    );
    expect(backupContent).toBe("original content");
  });

  it("trackEdit records null backup for non-existent files", async () => {
    await manager.makeSnapshot("msg-1", sessionId);
    await manager.trackEdit("/new-file.ts", "msg-1", sessionId);

    const backup = manager.getState().snapshots[0].trackedFileBackups["/new-file.ts"];
    expect(backup.backupFileName).toBeNull();
    expect(backup.version).toBe(1);
  });

  it("trackEdit skips if file already tracked in current snapshot", async () => {
    fs.files.set("/src/app.ts", "v1");
    await manager.makeSnapshot("msg-1", sessionId);
    await manager.trackEdit("/src/app.ts", "msg-1", sessionId);

    const backupBefore = manager.getState().snapshots[0].trackedFileBackups["/src/app.ts"];

    fs.files.set("/src/app.ts", "v2");
    await manager.trackEdit("/src/app.ts", "msg-1", sessionId);

    const backupAfter = manager.getState().snapshots[0].trackedFileBackups["/src/app.ts"];
    expect(backupAfter).toEqual(backupBefore);
  });

  it("makeSnapshot detects changed files and creates new versions", async () => {
    fs.files.set("/src/app.ts", "original");
    await manager.makeSnapshot("msg-1", sessionId);
    await manager.trackEdit("/src/app.ts", "msg-1", sessionId);

    fs.files.set("/src/app.ts", "modified");
    await manager.makeSnapshot("msg-2", sessionId);

    const state = manager.getState();
    expect(state.snapshots).toHaveLength(2);

    const snap2Backup = state.snapshots[1].trackedFileBackups["/src/app.ts"];
    expect(snap2Backup.version).toBe(2);
  });

  it("makeSnapshot reuses backup when file unchanged", async () => {
    fs.files.set("/src/app.ts", "stable");
    await manager.makeSnapshot("msg-1", sessionId);
    await manager.trackEdit("/src/app.ts", "msg-1", sessionId);

    await manager.makeSnapshot("msg-2", sessionId);

    const state = manager.getState();
    const snap1Backup = state.snapshots[0].trackedFileBackups["/src/app.ts"];
    const snap2Backup = state.snapshots[1].trackedFileBackups["/src/app.ts"];
    expect(snap2Backup).toEqual(snap1Backup);
  });

  it("rewind restores files to snapshot state", async () => {
    fs.files.set("/src/app.ts", "original");
    await manager.makeSnapshot("msg-1", sessionId);
    await manager.trackEdit("/src/app.ts", "msg-1", sessionId);

    fs.files.set("/src/app.ts", "modified");
    await manager.makeSnapshot("msg-2", sessionId);

    await manager.rewind("msg-1", sessionId);
    expect(await fs.readFile("/src/app.ts")).toBe("original");
  });

  it("rewind deletes files that didn't exist at snapshot", async () => {
    await manager.makeSnapshot("msg-1", sessionId);
    await manager.trackEdit("/new-file.ts", "msg-1", sessionId);

    fs.files.set("/new-file.ts", "created later");
    await manager.makeSnapshot("msg-2", sessionId);

    await manager.rewind("msg-1", sessionId);
    expect(await fs.exists("/new-file.ts")).toBe(false);
  });

  it("rewind throws when messageId not found", async () => {
    await expect(manager.rewind("nonexistent", sessionId)).rejects.toThrow(
      "No checkpoint snapshot found",
    );
  });

  it("canRestore returns correct boolean", async () => {
    await manager.makeSnapshot("msg-1", sessionId);
    expect(manager.canRestore("msg-1")).toBe(true);
    expect(manager.canRestore("msg-2")).toBe(false);
  });

  it("evicts snapshots beyond maxSnapshots", async () => {
    for (let i = 0; i < 7; i++) {
      await manager.makeSnapshot(`msg-${i}`, sessionId);
    }
    const state = manager.getState();
    expect(state.snapshots).toHaveLength(5);
    expect(state.snapshotSequence).toBe(7);
    expect(state.snapshots[0].messageId).toBe("msg-2");
  });

  it("getDiffStats returns insertion and deletion counts", async () => {
    fs.files.set("/src/app.ts", "line1\nline2\nline3");
    await manager.makeSnapshot("msg-1", sessionId);
    await manager.trackEdit("/src/app.ts", "msg-1", sessionId);

    fs.files.set("/src/app.ts", "line1\nmodified\nline3\nline4");
    await manager.makeSnapshot("msg-2", sessionId);

    const stats = await manager.getDiffStats("msg-1", sessionId);
    expect(stats).toBeDefined();
    expect(stats!.filesChanged).toContain("/src/app.ts");
    expect(stats!.insertions).toBeGreaterThan(0);
  });

  it("getDiffStats returns undefined for unknown messageId", async () => {
    const stats = await manager.getDiffStats("nonexistent", sessionId);
    expect(stats).toBeUndefined();
  });

  it("restoreStateFromEntries rebuilds state from snapshots", () => {
    const snapshots = [
      {
        messageId: "msg-1",
        trackedFileBackups: {
          "/src/a.ts": { backupFileName: "abc@v1", version: 1, backupTime: "2025-01-01" },
        },
        timestamp: "2025-01-01",
      },
      {
        messageId: "msg-2",
        trackedFileBackups: {
          "/src/a.ts": { backupFileName: "abc@v2", version: 2, backupTime: "2025-01-02" },
          "/src/b.ts": { backupFileName: "def@v1", version: 1, backupTime: "2025-01-02" },
        },
        timestamp: "2025-01-02",
      },
    ];

    manager.restoreStateFromEntries(snapshots);
    const state = manager.getState();
    expect(state.snapshots).toHaveLength(2);
    expect(state.trackedFiles.has("/src/a.ts")).toBe(true);
    expect(state.trackedFiles.has("/src/b.ts")).toBe(true);
    expect(state.snapshotSequence).toBe(2);
  });
});
