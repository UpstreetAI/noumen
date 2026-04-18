import type { VirtualFs } from "../virtual/fs.js";
import type {
  ChatMessage,
  Entry,
  MessageEntry,
  CompactBoundaryEntry,
  SummaryEntry,
  MetadataEntry,
  ToolResultOverflowEntry,
  FileCheckpointEntry,
  ContentReplacementEntry,
  ContentReplacementRecord,
  SnipBoundaryEntry,
  SessionInfo,
  CustomTitleEntry,
  AiTitleEntry,
} from "./types.js";
import type { FileCheckpointSnapshot } from "../checkpoint/types.js";
import { generateUUID } from "../utils/uuid.js";
import type { UUID } from "../utils/uuid.js";
import { jsonStringify, parseJSONL } from "../utils/json.js";

export class SessionStorage {
  private fs: VirtualFs;
  private sessionDir: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(fs: VirtualFs, sessionDir: string) {
    this.fs = fs;
    this.sessionDir = sessionDir;
  }

  /**
   * Serialize writes through a simple promise chain so parallel
   * appendEntry calls don't interleave large JSONL records.
   */
  private serializedWrite(fn: () => Promise<void>): Promise<void> {
    const next = this.writeLock.then(fn, fn);
    this.writeLock = next.then(() => {}, () => {});
    return next;
  }

  private getTranscriptPath(sessionId: string): string {
    return `${this.sessionDir}/${sessionId}.jsonl`;
  }

  async ensureDir(): Promise<void> {
    const exists = await this.fs.exists(this.sessionDir);
    if (!exists) {
      await this.fs.mkdir(this.sessionDir, { recursive: true });
    }
  }

  async appendEntry(sessionId: string, entry: Entry): Promise<void> {
    return this.serializedWrite(async () => {
      await this.ensureDir();
      const line = jsonStringify(entry) + "\n";
      await this.fs.appendFile(this.getTranscriptPath(sessionId), line);
    });
  }

  /**
   * Append multiple entries atomically as a single write.
   * All entries are serialized into one string and written in one appendFile
   * call, preventing partial writes on crash.
   */
  async appendEntriesBatch(sessionId: string, entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    return this.serializedWrite(async () => {
      await this.ensureDir();
      const lines = entries.map((e) => jsonStringify(e) + "\n").join("");
      await this.fs.appendFile(this.getTranscriptPath(sessionId), lines);
    });
  }

  async appendMessage(
    sessionId: string,
    message: ChatMessage,
    parentUuid: UUID | null = null,
  ): Promise<UUID> {
    const uuid = generateUUID();
    const entry: MessageEntry = {
      type: "message",
      uuid,
      parentUuid,
      sessionId,
      timestamp: new Date().toISOString(),
      message,
    };
    await this.appendEntry(sessionId, entry);
    return uuid;
  }

  async appendCompactBoundary(sessionId: string): Promise<UUID> {
    const uuid = generateUUID();
    const entry: CompactBoundaryEntry = {
      type: "compact-boundary",
      uuid,
      sessionId,
      timestamp: new Date().toISOString(),
    };
    await this.appendEntry(sessionId, entry);
    return uuid;
  }

  async appendSummary(
    sessionId: string,
    summaryMessage: ChatMessage,
    parentUuid: UUID | null = null,
  ): Promise<UUID> {
    const uuid = generateUUID();
    const entry: SummaryEntry = {
      type: "summary",
      uuid,
      parentUuid,
      sessionId,
      timestamp: new Date().toISOString(),
      message: summaryMessage,
    };
    await this.appendEntry(sessionId, entry);
    return uuid;
  }

  async appendToolResultOverflow(
    sessionId: string,
    toolCallId: string,
    originalContent: string,
  ): Promise<void> {
    const entry: ToolResultOverflowEntry = {
      type: "tool-result-overflow",
      sessionId,
      timestamp: new Date().toISOString(),
      toolCallId,
      originalContent,
    };
    await this.appendEntry(sessionId, entry);
  }

  async appendCheckpointEntry(
    sessionId: string,
    messageId: string,
    snapshot: FileCheckpointSnapshot,
    isSnapshotUpdate: boolean,
  ): Promise<void> {
    const entry: FileCheckpointEntry = {
      type: "file-checkpoint",
      sessionId,
      timestamp: new Date().toISOString(),
      messageId,
      snapshot,
      isSnapshotUpdate,
    };
    await this.appendEntry(sessionId, entry);
  }

  async appendSnipBoundary(
    sessionId: string,
    removedUuids: string[],
  ): Promise<void> {
    if (removedUuids.length === 0) return;
    const entry: SnipBoundaryEntry = {
      type: "snip-boundary",
      sessionId,
      timestamp: new Date().toISOString(),
      snipMetadata: { removedUuids },
    };
    await this.appendEntry(sessionId, entry);
  }

  async appendContentReplacement(
    sessionId: string,
    replacements: ContentReplacementRecord[],
  ): Promise<void> {
    if (replacements.length === 0) return;
    const entry: ContentReplacementEntry = {
      type: "content-replacement",
      sessionId,
      timestamp: new Date().toISOString(),
      replacements,
    };
    await this.appendEntry(sessionId, entry);
  }

  async appendMetadata(
    sessionId: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    const entry: MetadataEntry = {
      type: "metadata",
      sessionId,
      timestamp: new Date().toISOString(),
      key,
      value,
    };
    await this.appendEntry(sessionId, entry);
  }

  /**
   * Append a user-set session title. Wins over any `ai-title` when read.
   * Idempotent-ish: callers may append as many as they like; the last one
   * wins according to file order.
   */
  async appendCustomTitle(sessionId: string, title: string): Promise<void> {
    const entry: CustomTitleEntry = {
      type: "custom-title",
      sessionId,
      title,
      timestamp: new Date().toISOString(),
    };
    await this.appendEntry(sessionId, entry);
  }

  /**
   * Append an AI-generated session title. A `custom-title` (if present)
   * always takes precedence on read.
   */
  async appendAiTitle(sessionId: string, title: string): Promise<void> {
    const entry: AiTitleEntry = {
      type: "ai-title",
      sessionId,
      title,
      timestamp: new Date().toISOString(),
    };
    await this.appendEntry(sessionId, entry);
  }

  /**
   * Re-append custom-title, ai-title, and key metadata entries after a
   * compact boundary so they remain discoverable in the active-entries
   * window.
   */
  async reAppendMetadataAfterCompact(sessionId: string): Promise<void> {
    const entries = await this.loadAllEntries(sessionId);
    let customTitle: string | undefined;
    let aiTitle: string | undefined;
    const metadataByKey = new Map<string, unknown>();

    for (const entry of entries) {
      if (entry.type === "custom-title") {
        customTitle = entry.title;
      }
      if (entry.type === "ai-title") {
        aiTitle = entry.title;
      }
      if (entry.type === "metadata") {
        metadataByKey.set(entry.key, entry.value);
      }
    }

    if (customTitle) {
      await this.appendCustomTitle(sessionId, customTitle);
    }
    if (aiTitle) {
      await this.appendAiTitle(sessionId, aiTitle);
    }

    for (const [key, value] of metadataByKey) {
      await this.appendMetadata(sessionId, key, value);
    }
  }

  async loadMessages(sessionId: string): Promise<ChatMessage[]> {
    const path = this.getTranscriptPath(sessionId);

    const exists = await this.fs.exists(path);
    if (!exists) return [];

    const content = await this.fs.readFile(path);
    const entries = parseJSONL<Entry>(content);

    let lastBoundaryIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "compact-boundary") {
        // Validate: boundary must have at least one summary or message after it.
        // If not (crash between boundary + summary write), skip to the prior boundary.
        const afterBoundary = entries.slice(i + 1);
        const hasSummaryOrMessage = afterBoundary.some(
          (e) => e.type === "summary" || e.type === "message",
        );
        if (hasSummaryOrMessage) {
          lastBoundaryIdx = i;
          break;
        }
        // else: orphaned boundary — keep searching backwards
      }
    }

    const activeEntries = entries.slice(lastBoundaryIdx + 1);

    const snippedUuids = new Set<string>();
    for (const entry of activeEntries) {
      if (entry.type === "snip-boundary") {
        for (const uuid of entry.snipMetadata.removedUuids) {
          snippedUuids.add(uuid);
        }
      }
    }

    const messages: ChatMessage[] = [];
    for (const entry of activeEntries) {
      if (entry.type === "message" || entry.type === "summary") {
        if (!snippedUuids.has(entry.uuid)) {
          messages.push(entry.message);
        }
      }
    }

    return messages;
  }

  async loadAllEntries(sessionId: string): Promise<Entry[]> {
    const path = this.getTranscriptPath(sessionId);

    const exists = await this.fs.exists(path);
    if (!exists) return [];

    const content = await this.fs.readFile(path);
    return parseJSONL<Entry>(content);
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    return this.fs.exists(this.getTranscriptPath(sessionId));
  }

  /**
   * Return the currently persisted titles for a session. `title` reflects
   * the display preference (custom > ai). Returns all-undefined if the
   * session file doesn't exist.
   */
  async getSessionTitles(sessionId: string): Promise<{
    title?: string;
    customTitle?: string;
    aiTitle?: string;
  }> {
    const entries = await this.loadAllEntries(sessionId);
    let customTitle: string | undefined;
    let aiTitle: string | undefined;
    for (const entry of entries) {
      if (entry.type === "custom-title") customTitle = entry.title;
      if (entry.type === "ai-title") aiTitle = entry.title;
    }
    return { title: customTitle ?? aiTitle, customTitle, aiTitle };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const filePath = this.getTranscriptPath(sessionId);
    const exists = await this.fs.exists(filePath);
    if (exists) {
      await this.fs.deleteFile(filePath);
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    await this.ensureDir();

    let dirEntries;
    try {
      dirEntries = await this.fs.readdir(this.sessionDir);
    } catch {
      return [];
    }

    const sessions: SessionInfo[] = [];
    const LITE_READ_LIMIT = 32_768;

    for (const dirEntry of dirEntries) {
      if (!dirEntry.name.endsWith(".jsonl")) continue;

      const sessionId = dirEntry.name.replace(".jsonl", "");
      try {
        const filePath = this.getTranscriptPath(sessionId);

        // Cap reads to avoid OOM on very large session files.
        // VirtualFs implementations that support maxBytes will only read the
        // first LITE_READ_LIMIT * 2 bytes; others return the full content.
        const content = await this.fs.readFile(filePath, {
          maxBytes: LITE_READ_LIMIT * 2,
        });

        let headSlice: string;
        let tailSlice: string;
        const isSplit = content.length >= LITE_READ_LIMIT * 2;
        if (isSplit) {
          const headEnd = content.lastIndexOf('\n', LITE_READ_LIMIT);
          headSlice = headEnd > 0 ? content.slice(0, headEnd) : content.slice(0, LITE_READ_LIMIT);
          const tailStart = content.indexOf('\n', content.length - LITE_READ_LIMIT);
          tailSlice = tailStart >= 0 ? content.slice(tailStart + 1) : content.slice(-LITE_READ_LIMIT);
        } else {
          headSlice = content;
          tailSlice = content;
        }

        const headEntries = parseJSONL<Entry>(headSlice);
        const tailEntries = isSplit
          ? parseJSONL<Entry>(tailSlice)
          : headEntries;

        let customTitle: string | undefined;
        let aiTitle: string | undefined;
        let firstTimestamp: string | undefined;
        let lastTimestamp: string | undefined;
        let messageCount = 0;

        for (const e of headEntries) {
          if (e.type === "message" || e.type === "summary") {
            messageCount++;
            if (!firstTimestamp) firstTimestamp = e.timestamp;
            lastTimestamp = e.timestamp;
          }
          if (e.type === "custom-title") customTitle = e.title;
          if (e.type === "ai-title") aiTitle = e.title;
        }

        if (isSplit) {
          for (const e of tailEntries) {
            if (e.type === "message" || e.type === "summary") {
              messageCount++;
              if (e.timestamp) lastTimestamp = e.timestamp;
            }
            if (e.type === "custom-title") customTitle = e.title;
            if (e.type === "ai-title") aiTitle = e.title;
          }
        }

        sessions.push({
          sessionId,
          createdAt: firstTimestamp ?? new Date().toISOString(),
          lastMessageAt: lastTimestamp ?? new Date().toISOString(),
          title: customTitle ?? aiTitle,
          customTitle,
          aiTitle,
          messageCount,
        });
      } catch {
        // skip corrupt sessions
      }
    }

    return sessions.sort(
      (a, b) =>
        new Date(b.lastMessageAt).getTime() -
        new Date(a.lastMessageAt).getTime(),
    );
  }
}
