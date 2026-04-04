export type MemoryType = "user" | "project" | "feedback" | "reference";

export interface MemoryEntry {
  /** Short identifier used as the basis for the filename. */
  name: string;
  /** One-line summary of what this memory contains. */
  description: string;
  type: MemoryType;
  /** Full markdown content of the memory (excluding frontmatter). */
  content: string;
  /** Relative path within the memory directory (e.g. `"user_prefs.md"`). */
  path?: string;
  updatedAt?: string;
}

export interface MemoryProvider {
  /** Load the MEMORY.md index content for system-prompt injection. */
  loadIndex(): Promise<string>;
  /** Load a single memory entry by its path within the memory directory. */
  loadEntry(path: string): Promise<MemoryEntry | null>;
  /** Write or update a memory entry and refresh the index. */
  saveEntry(entry: MemoryEntry): Promise<void>;
  /** Delete a memory entry and refresh the index. */
  removeEntry(path: string): Promise<void>;
  /** List all memory entries in the directory. */
  listEntries(): Promise<MemoryEntry[]>;
  /** Simple keyword search across entry names and content. */
  search(query: string): Promise<MemoryEntry[]>;
}

export interface MemoryConfig {
  provider: MemoryProvider;
  /** Run LLM-driven memory extraction after each turn (default: false). */
  autoExtract?: boolean;
  /** Maximum number of lines in the MEMORY.md index before truncation (default: 200). */
  maxIndexLines?: number;
  /** Inject the memory index into the system prompt (default: true). */
  injectIntoSystemPrompt?: boolean;
}
