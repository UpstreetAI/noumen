import { createHash } from "node:crypto";
import type { VirtualFs } from "../virtual/fs.js";
import type {
  FileCheckpointBackup,
  FileCheckpointSnapshot,
  FileCheckpointState,
  CheckpointConfig,
  DiffStats,
} from "./types.js";
import { createCheckpointState } from "./types.js";

const DEFAULT_MAX_SNAPSHOTS = 100;
const DEFAULT_BACKUP_DIR = ".noumen/checkpoints";

function hashFilePath(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 16);
}

function backupFileName(filePath: string, version: number): string {
  return `${hashFilePath(filePath)}@v${version}`;
}

export class FileCheckpointManager {
  private fs: VirtualFs;
  private maxSnapshots: number;
  private backupDir: string;
  private state: FileCheckpointState;

  constructor(fs: VirtualFs, config: CheckpointConfig) {
    this.fs = fs;
    this.maxSnapshots = config.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
    this.backupDir = config.backupDir ?? DEFAULT_BACKUP_DIR;
    this.state = createCheckpointState();
  }

  getState(): FileCheckpointState {
    return this.state;
  }

  private sessionBackupDir(sessionId: string): string {
    return `${this.backupDir}/${sessionId}`;
  }

  private resolveBackupPath(sessionId: string, bkFileName: string): string {
    return `${this.sessionBackupDir(sessionId)}/${bkFileName}`;
  }

  private async ensureBackupDir(sessionId: string): Promise<void> {
    const dir = this.sessionBackupDir(sessionId);
    const exists = await this.fs.exists(dir);
    if (!exists) {
      await this.fs.mkdir(dir, { recursive: true });
    }
  }

  private async createBackup(
    filePath: string,
    version: number,
    sessionId: string,
  ): Promise<FileCheckpointBackup> {
    const exists = await this.fs.exists(filePath);
    if (!exists) {
      return {
        backupFileName: null,
        version,
        backupTime: new Date().toISOString(),
      };
    }

    await this.ensureBackupDir(sessionId);
    const bkName = backupFileName(filePath, version);
    const bkPath = this.resolveBackupPath(sessionId, bkName);
    const content = await this.fs.readFile(filePath);
    await this.fs.writeFile(bkPath, content);

    return {
      backupFileName: bkName,
      version,
      backupTime: new Date().toISOString(),
    };
  }

  private async restoreBackup(
    filePath: string,
    bkFileName: string,
    sessionId: string,
  ): Promise<void> {
    const bkPath = this.resolveBackupPath(sessionId, bkFileName);
    const exists = await this.fs.exists(bkPath);
    if (!exists) return;

    const content = await this.fs.readFile(bkPath);
    await this.fs.writeFile(filePath, content);
  }

  private async hasFileChanged(
    filePath: string,
    backup: FileCheckpointBackup,
    sessionId: string,
  ): Promise<boolean> {
    const fileExists = await this.fs.exists(filePath);

    if (backup.backupFileName === null) {
      return fileExists;
    }

    if (!fileExists) return true;

    const bkPath = this.resolveBackupPath(sessionId, backup.backupFileName);
    const bkExists = await this.fs.exists(bkPath);
    if (!bkExists) return true;

    const currentContent = await this.fs.readFile(filePath);
    const backupContent = await this.fs.readFile(bkPath);
    return currentContent !== backupContent;
  }

  /**
   * Create a new snapshot at the start of a user turn.
   * For each tracked file, checks if it changed since the last backup and
   * creates a new versioned backup if so.
   */
  async makeSnapshot(messageId: string, sessionId: string): Promise<void> {
    const state = this.state;
    const mostRecent = state.snapshots.at(-1);

    const newBackups: Record<string, FileCheckpointBackup> = {};

    if (mostRecent) {
      for (const trackingPath of state.trackedFiles) {
        const lastBackup = mostRecent.trackedFileBackups[trackingPath];
        if (!lastBackup) continue;

        const changed = await this.hasFileChanged(trackingPath, lastBackup, sessionId);
        if (changed) {
          const nextVersion = lastBackup.version + 1;
          newBackups[trackingPath] = await this.createBackup(
            trackingPath,
            nextVersion,
            sessionId,
          );
        } else {
          newBackups[trackingPath] = lastBackup;
        }
      }
    }

    const snapshot: FileCheckpointSnapshot = {
      messageId,
      trackedFileBackups: newBackups,
      timestamp: new Date().toISOString(),
    };

    state.snapshots.push(snapshot);
    if (state.snapshots.length > this.maxSnapshots) {
      state.snapshots = state.snapshots.slice(-this.maxSnapshots);
    }
    state.snapshotSequence++;
  }

  /**
   * Track a file before it is edited. Creates the v1 backup (pre-edit state)
   * and attaches it to the current (latest) snapshot.
   * Called by write/edit tools before mutation.
   */
  async trackEdit(
    filePath: string,
    messageId: string,
    sessionId: string,
  ): Promise<void> {
    const state = this.state;
    const mostRecent = state.snapshots.at(-1);
    if (!mostRecent) return;

    if (mostRecent.trackedFileBackups[filePath]) return;

    const backup = await this.createBackup(filePath, 1, sessionId);
    mostRecent.trackedFileBackups[filePath] = backup;
    state.trackedFiles.add(filePath);
  }

  /**
   * Restore all tracked files to the state captured in the snapshot
   * matching the given messageId. Files that didn't exist at that point
   * are deleted; files that existed are restored from backups.
   */
  async rewind(messageId: string, sessionId: string): Promise<void> {
    const state = this.state;

    let targetSnapshot: FileCheckpointSnapshot | undefined;
    for (let i = state.snapshots.length - 1; i >= 0; i--) {
      if (state.snapshots[i].messageId === messageId) {
        targetSnapshot = state.snapshots[i];
        break;
      }
    }

    if (!targetSnapshot) {
      throw new Error(`No checkpoint snapshot found for messageId: ${messageId}`);
    }

    for (const trackingPath of state.trackedFiles) {
      const backup = targetSnapshot.trackedFileBackups[trackingPath];
      if (!backup) continue;

      if (backup.backupFileName === null) {
        const exists = await this.fs.exists(trackingPath);
        if (exists) {
          await this.fs.deleteFile(trackingPath);
        }
      } else {
        const changed = await this.hasFileChanged(trackingPath, backup, sessionId);
        if (changed) {
          await this.restoreBackup(trackingPath, backup.backupFileName, sessionId);
        }
      }
    }
  }

  canRestore(messageId: string): boolean {
    return this.state.snapshots.some((s) => s.messageId === messageId);
  }

  async getDiffStats(
    messageId: string,
    sessionId: string,
  ): Promise<DiffStats> {
    const state = this.state;

    let targetSnapshot: FileCheckpointSnapshot | undefined;
    for (let i = state.snapshots.length - 1; i >= 0; i--) {
      if (state.snapshots[i].messageId === messageId) {
        targetSnapshot = state.snapshots[i];
        break;
      }
    }

    if (!targetSnapshot) return undefined;

    let insertions = 0;
    let deletions = 0;
    const filesChanged: string[] = [];

    for (const trackingPath of state.trackedFiles) {
      const backup = targetSnapshot.trackedFileBackups[trackingPath];
      if (!backup) continue;

      const currentExists = await this.fs.exists(trackingPath);
      const currentContent = currentExists
        ? await this.fs.readFile(trackingPath)
        : "";

      let backupContent = "";
      if (backup.backupFileName !== null) {
        const bkPath = this.resolveBackupPath(sessionId, backup.backupFileName);
        const bkExists = await this.fs.exists(bkPath);
        if (bkExists) {
          backupContent = await this.fs.readFile(bkPath);
        }
      }

      if (currentContent === backupContent) continue;

      filesChanged.push(trackingPath);
      const currentLines = currentContent.split("\n");
      const backupLines = backupContent.split("\n");

      const maxLen = Math.max(currentLines.length, backupLines.length);
      for (let i = 0; i < maxLen; i++) {
        const cur = currentLines[i];
        const bak = backupLines[i];
        if (cur !== bak) {
          if (cur !== undefined && bak === undefined) {
            insertions++;
          } else if (cur === undefined && bak !== undefined) {
            deletions++;
          } else {
            insertions++;
            deletions++;
          }
        }
      }
    }

    return { filesChanged, insertions, deletions };
  }

  /**
   * Rebuild checkpoint state from persisted JSONL entries (for session resume).
   * Mirrors claude-code's buildFileHistorySnapshotChain + fileHistoryRestoreStateFromLog.
   */
  restoreStateFromEntries(snapshots: FileCheckpointSnapshot[]): void {
    const trackedFiles = new Set<string>();
    for (const snap of snapshots) {
      for (const path of Object.keys(snap.trackedFileBackups)) {
        trackedFiles.add(path);
      }
    }

    this.state = {
      snapshots: [...snapshots],
      trackedFiles,
      snapshotSequence: snapshots.length,
    };
  }
}
