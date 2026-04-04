import type { VirtualFs } from "../virtual/fs.js";
import type {
  ChatMessage,
  Entry,
  MessageEntry,
  CompactBoundaryEntry,
  SummaryEntry,
  ToolResultOverflowEntry,
  SessionInfo,
} from "./types.js";
import { generateUUID } from "../utils/uuid.js";
import type { UUID } from "../utils/uuid.js";
import { jsonStringify, parseJSONL } from "../utils/json.js";

export class SessionStorage {
  private fs: VirtualFs;
  private sessionDir: string;

  constructor(fs: VirtualFs, sessionDir: string) {
    this.fs = fs;
    this.sessionDir = sessionDir;
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
    await this.ensureDir();
    const line = jsonStringify(entry) + "\n";
    await this.fs.appendFile(this.getTranscriptPath(sessionId), line);
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

  async loadMessages(sessionId: string): Promise<ChatMessage[]> {
    const path = this.getTranscriptPath(sessionId);

    const exists = await this.fs.exists(path);
    if (!exists) return [];

    const content = await this.fs.readFile(path);
    const entries = parseJSONL<Entry>(content);

    // Find the last compact boundary, if any
    let lastBoundaryIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "compact-boundary") {
        lastBoundaryIdx = i;
        break;
      }
    }

    const messages: ChatMessage[] = [];
    const startIdx = lastBoundaryIdx + 1;

    for (let i = startIdx; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.type === "message" || entry.type === "summary") {
        messages.push(entry.message);
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

  async listSessions(): Promise<SessionInfo[]> {
    await this.ensureDir();

    let entries;
    try {
      entries = await this.fs.readdir(this.sessionDir);
    } catch {
      return [];
    }

    const sessions: SessionInfo[] = [];

    for (const entry of entries) {
      if (!entry.name.endsWith(".jsonl")) continue;

      const sessionId = entry.name.replace(".jsonl", "");
      try {
        const content = await this.fs.readFile(
          this.getTranscriptPath(sessionId),
        );
        const allEntries = parseJSONL<Entry>(content);

        let messageCount = 0;
        let title: string | undefined;
        let firstTimestamp: string | undefined;
        let lastTimestamp: string | undefined;

        for (const e of allEntries) {
          if (e.type === "message" || e.type === "summary") {
            messageCount++;
            if (!firstTimestamp) firstTimestamp = e.timestamp;
            lastTimestamp = e.timestamp;
          }
          if (e.type === "custom-title") {
            title = e.title;
          }
        }

        sessions.push({
          sessionId,
          createdAt: firstTimestamp ?? new Date().toISOString(),
          lastMessageAt: lastTimestamp ?? new Date().toISOString(),
          title,
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
