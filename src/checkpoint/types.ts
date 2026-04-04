/**
 * File checkpointing types.
 *
 * Adapted from claude-code's fileHistory system. Key difference: all I/O
 * routes through VirtualFs so checkpointing works in any sandbox (Docker,
 * E2B, Sprites, local).
 */

export interface FileCheckpointBackup {
  /** Backup filename under the session backup dir, or null if the file did not exist at this version. */
  backupFileName: string | null;
  version: number;
  backupTime: string;
}

export interface FileCheckpointSnapshot {
  messageId: string;
  /** Map of tracked file paths → their backup at this snapshot. */
  trackedFileBackups: Record<string, FileCheckpointBackup>;
  timestamp: string;
}

export interface FileCheckpointState {
  snapshots: FileCheckpointSnapshot[];
  trackedFiles: Set<string>;
  /**
   * Monotonically-increasing counter incremented on every snapshot, even when
   * old snapshots are evicted. Useful as an activity signal (snapshots.length
   * plateaus once the cap is reached).
   */
  snapshotSequence: number;
}

export interface CheckpointConfig {
  enabled: boolean;
  /** Maximum number of snapshots to retain before evicting oldest. Default: 100. */
  maxSnapshots?: number;
  /** Base directory for backup files. Default: ".noumen/checkpoints". */
  backupDir?: string;
}

export type DiffStats =
  | {
      filesChanged?: string[];
      insertions: number;
      deletions: number;
    }
  | undefined;

export function createCheckpointState(): FileCheckpointState {
  return {
    snapshots: [],
    trackedFiles: new Set(),
    snapshotSequence: 0,
  };
}
