import type { FileState, FileStateCacheConfig } from "./types.js";
import { normalize } from "node:path";

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * LRU cache tracking which files the model has read and at what mtime.
 *
 * Used by ReadFile to record reads and by EditFile/WriteFile to enforce
 * "read-before-edit" — the model cannot edit a file it hasn't seen,
 * preventing hallucinated edits on unseen content.
 */
export class FileStateCache {
  private entries: Map<string, FileState> = new Map();
  private maxEntries: number;
  private maxBytes: number;
  private currentBytes = 0;

  constructor(config?: FileStateCacheConfig) {
    this.maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = config?.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  private key(path: string): string {
    return normalize(path);
  }

  private byteSize(state: FileState): number {
    return Math.max(1, Buffer.byteLength(state.content, "utf8"));
  }

  set(path: string, state: FileState): void {
    const k = this.key(path);
    const existing = this.entries.get(k);
    if (existing) {
      this.currentBytes -= this.byteSize(existing);
      this.entries.delete(k);
    }

    const size = this.byteSize(state);

    // Evict LRU entries until we're under both caps.
    // Map iteration order = insertion order, so first entries are oldest.
    while (
      (this.entries.size >= this.maxEntries || this.currentBytes + size > this.maxBytes) &&
      this.entries.size > 0
    ) {
      const oldest = this.entries.keys().next().value!;
      const oldState = this.entries.get(oldest)!;
      this.currentBytes -= this.byteSize(oldState);
      this.entries.delete(oldest);
    }

    this.entries.set(k, state);
    this.currentBytes += size;
  }

  get(path: string): FileState | undefined {
    const k = this.key(path);
    const state = this.entries.get(k);
    if (!state) return undefined;

    // Touch: move to end of insertion order (most recently used)
    this.entries.delete(k);
    this.entries.set(k, state);
    return state;
  }

  has(path: string): boolean {
    return this.entries.has(this.key(path));
  }

  delete(path: string): void {
    const k = this.key(path);
    const existing = this.entries.get(k);
    if (existing) {
      this.currentBytes -= this.byteSize(existing);
      this.entries.delete(k);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.currentBytes;
  }

  clear(): void {
    this.entries.clear();
    this.currentBytes = 0;
  }
}
