/**
 * History snip: remove middle ranges of conversation history.
 *
 * Unlike prefix compaction (which summarizes and removes the oldest
 * messages), history snip removes specific message ranges from the middle
 * of the conversation. The JSONL transcript stays append-only — snipped
 * messages remain on disk but their UUIDs are recorded on a snip-boundary
 * entry so they're filtered out on resume.
 *
 * Parent pointers are relinked across gaps using path compression so the
 * conversation chain stays intact.
 */

import type { ChatMessage, Entry, MessageEntry, SummaryEntry } from "../session/types.js";
import type { UUID } from "../utils/uuid.js";

export interface SnipConfig {
  enabled: boolean;
}

export interface SnipResult {
  messages: ChatMessage[];
  removedCount: number;
  relinkedCount: number;
}

/**
 * UUID-keyed transcript message used during snip processing.
 * Mirrors the shape we need from JSONL entries for relinking.
 */
interface TranscriptMessage {
  uuid: UUID;
  parentUuid: UUID | null;
  message: ChatMessage;
}

/**
 * Apply snip removals to a UUID-keyed message map.
 *
 * Ported from claude-code's `applySnipRemovals`. Walks entries looking
 * for snip-boundary entries with `snipMetadata.removedUuids`, deletes
 * those messages, and relinks parentUuid across gaps with path compression.
 */
export function applySnipRemovals(
  entries: Entry[],
): { messages: ChatMessage[]; removedCount: number; relinkedCount: number } {
  // Collect all UUIDs to remove from snip-boundary entries
  const toDelete = new Set<UUID>();
  for (const entry of entries) {
    if (entry.type === "snip-boundary" && entry.snipMetadata?.removedUuids) {
      for (const uuid of entry.snipMetadata.removedUuids) {
        toDelete.add(uuid as UUID);
      }
    }
  }

  if (toDelete.size === 0) {
    // No snips — just extract messages in order
    const messages: ChatMessage[] = [];
    for (const entry of entries) {
      if (entry.type === "message" || entry.type === "summary") {
        messages.push(entry.message);
      }
    }
    return { messages, removedCount: 0, relinkedCount: 0 };
  }

  // Build a Map of UUID -> TranscriptMessage for relinking
  const messagesMap = new Map<UUID, TranscriptMessage>();
  const ordered: UUID[] = [];

  for (const entry of entries) {
    if (entry.type === "message" || entry.type === "summary") {
      const e = entry as MessageEntry | SummaryEntry;
      messagesMap.set(e.uuid, {
        uuid: e.uuid,
        parentUuid: e.parentUuid,
        message: e.message,
      });
      ordered.push(e.uuid);
    }
  }

  // Record parent pointers of deleted entries before removing them
  const deletedParent = new Map<UUID, UUID | null>();
  let removedCount = 0;
  for (const uuid of toDelete) {
    const entry = messagesMap.get(uuid);
    if (!entry) continue;
    deletedParent.set(uuid, entry.parentUuid);
    messagesMap.delete(uuid);
    removedCount++;
  }

  // Path-compression resolver: walk deleted parent chain to find a surviving ancestor
  const resolve = (start: UUID): UUID | null => {
    const path: UUID[] = [];
    let cur: UUID | null | undefined = start;
    while (cur && toDelete.has(cur)) {
      path.push(cur);
      cur = deletedParent.get(cur);
      if (cur === undefined) {
        cur = null;
        break;
      }
    }
    // Path compression: cache resolved parent for all nodes on the path
    for (const p of path) {
      deletedParent.set(p, cur);
    }
    return cur;
  };

  // Relink surviving messages whose parent was deleted
  let relinkedCount = 0;
  for (const [uuid, msg] of messagesMap) {
    if (!msg.parentUuid || !toDelete.has(msg.parentUuid)) continue;
    const newParent = resolve(msg.parentUuid);
    messagesMap.set(uuid, { ...msg, parentUuid: newParent });
    relinkedCount++;
  }

  // Rebuild ordered message array (preserving original insertion order)
  const result: ChatMessage[] = [];
  for (const uuid of ordered) {
    const msg = messagesMap.get(uuid);
    if (msg) {
      result.push(msg.message);
    }
  }

  return { messages: result, removedCount, relinkedCount };
}

/**
 * Snip specific messages from an in-memory message array by UUID.
 *
 * This is the in-memory operation — call this during a live thread to
 * remove messages before the next model call. The caller is responsible
 * for persisting a snip-boundary entry to the JSONL transcript.
 */
export function snipMessagesByUuids(
  entries: Array<{ uuid: UUID; parentUuid: UUID | null; message: ChatMessage }>,
  removedUuids: Set<UUID>,
): SnipResult {
  if (removedUuids.size === 0) {
    return {
      messages: entries.map((e) => e.message),
      removedCount: 0,
      relinkedCount: 0,
    };
  }

  const deletedParent = new Map<UUID, UUID | null>();
  const surviving: Array<{ uuid: UUID; parentUuid: UUID | null; message: ChatMessage }> = [];

  for (const entry of entries) {
    if (removedUuids.has(entry.uuid)) {
      deletedParent.set(entry.uuid, entry.parentUuid);
    } else {
      surviving.push({ ...entry });
    }
  }

  const resolve = (start: UUID): UUID | null => {
    const path: UUID[] = [];
    let cur: UUID | null | undefined = start;
    while (cur && removedUuids.has(cur)) {
      path.push(cur);
      cur = deletedParent.get(cur);
      if (cur === undefined) {
        cur = null;
        break;
      }
    }
    for (const p of path) {
      deletedParent.set(p, cur);
    }
    return cur;
  };

  let relinkedCount = 0;
  for (const entry of surviving) {
    if (entry.parentUuid && removedUuids.has(entry.parentUuid)) {
      entry.parentUuid = resolve(entry.parentUuid);
      relinkedCount++;
    }
  }

  return {
    messages: surviving.map((e) => e.message),
    removedCount: removedUuids.size,
    relinkedCount,
  };
}

/**
 * Project a "snipped view" of messages for the model.
 *
 * Filters out messages marked as snipped. Use the `includeSnipped` option
 * to get the full scrollback for UI display.
 */
export function projectSnippedView(
  messages: ChatMessage[],
  snippedIndices: Set<number>,
  opts?: { includeSnipped?: boolean },
): ChatMessage[] {
  if (opts?.includeSnipped || snippedIndices.size === 0) {
    return messages;
  }
  return messages.filter((_, i) => !snippedIndices.has(i));
}
