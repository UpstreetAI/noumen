/**
 * Session resume / restore.
 *
 * Parses a persisted JSONL session and extracts everything needed to
 * reconstruct thread state: messages (respecting compact boundaries),
 * file checkpoint snapshots, metadata, and tool result overflow entries.
 */

import type { SessionStorage } from "./storage.js";
import type {
  ChatMessage,
  Entry,
  FileCheckpointEntry,
  ToolResultOverflowEntry,
  ContentReplacementRecord,
} from "./types.js";
import type { FileCheckpointSnapshot } from "../checkpoint/types.js";
import type { StoredCostState } from "../cost/tracker.js";
import { applySnipRemovals } from "../compact/history-snip.js";

export interface ResumePayload {
  messages: ChatMessage[];
  checkpointSnapshots: FileCheckpointSnapshot[];
  metadata: Record<string, unknown>;
  costState?: StoredCostState;
  overflowEntries: ToolResultOverflowEntry[];
  /** Persisted content replacement records for disk-spilled tool results. */
  contentReplacements: ContentReplacementRecord[];
}

/**
 * Build the ordered checkpoint snapshot chain from JSONL entries.
 *
 * Mirrors claude-code's `buildFileHistorySnapshotChain`: walks message
 * entries in order, matches each to collected checkpoint entries by
 * messageId. When `isSnapshotUpdate` is true, replaces the most recent
 * snapshot with that messageId; otherwise appends.
 */
function buildCheckpointChain(
  entries: Entry[],
  checkpointsByMessageId: Map<string, FileCheckpointEntry>,
): FileCheckpointSnapshot[] {
  const snapshots: FileCheckpointSnapshot[] = [];

  for (const entry of entries) {
    if (entry.type !== "message" && entry.type !== "summary") continue;

    const cpEntry = checkpointsByMessageId.get(entry.uuid);
    if (!cpEntry) continue;

    if (cpEntry.isSnapshotUpdate) {
      const existingIdx = snapshots.findIndex(
        (s) => s.messageId === cpEntry.snapshot.messageId,
      );
      if (existingIdx >= 0) {
        snapshots[existingIdx] = cpEntry.snapshot;
      } else {
        snapshots.push(cpEntry.snapshot);
      }
    } else {
      snapshots.push(cpEntry.snapshot);
    }
  }

  return snapshots;
}

/**
 * Restore a session from its persisted JSONL transcript.
 *
 * Returns everything needed to reconstruct Thread state:
 * - Messages after the last compact boundary
 * - File checkpoint snapshot chain
 * - Session metadata (title, custom keys)
 * - Tool result overflow entries
 */
export async function restoreSession(
  storage: SessionStorage,
  sessionId: string,
): Promise<ResumePayload> {
  const entries = await storage.loadAllEntries(sessionId);

  let lastBoundaryIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compact-boundary") {
      lastBoundaryIdx = i;
      break;
    }
  }

  const startIdx = lastBoundaryIdx + 1;
  const activeEntries = entries.slice(startIdx);

  // Check if there are any snip boundaries to process
  const hasSnips = activeEntries.some((e) => e.type === "snip-boundary");

  let messages: ChatMessage[];
  if (hasSnips) {
    // Apply snip removals with parent relinking
    const snipResult = applySnipRemovals(activeEntries);
    messages = snipResult.messages;
  } else {
    messages = [];
    for (const entry of activeEntries) {
      if (entry.type === "message" || entry.type === "summary") {
        messages.push(entry.message);
      }
    }
  }

  const checkpointsByMessageId = new Map<string, FileCheckpointEntry>();
  const overflowEntries: ToolResultOverflowEntry[] = [];
  const contentReplacements: ContentReplacementRecord[] = [];
  const metadata: Record<string, unknown> = {};

  for (const entry of entries) {
    if (entry.type === "file-checkpoint") {
      checkpointsByMessageId.set(entry.messageId, entry);
    } else if (entry.type === "tool-result-overflow") {
      overflowEntries.push(entry);
    } else if (entry.type === "content-replacement") {
      contentReplacements.push(...entry.replacements);
    } else if (entry.type === "custom-title") {
      metadata.title = entry.title;
    } else if (entry.type === "metadata") {
      metadata[entry.key] = entry.value;
    }
  }

  const checkpointSnapshots = buildCheckpointChain(entries, checkpointsByMessageId);

  return {
    messages,
    checkpointSnapshots,
    metadata,
    overflowEntries,
    contentReplacements,
  };
}
