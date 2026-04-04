export interface FileState {
  /** The content the model saw (may be a line slice, not the full file). */
  content: string;
  /** File mtime at the time of read (ms since epoch). */
  timestamp: number;
  /** 1-based start line of the read window (undefined = full file or post-edit snapshot). */
  offset?: number;
  /** Line count of the read window (undefined = full file or post-edit snapshot). */
  limit?: number;
  /**
   * When true, the model saw a transformed/truncated view (e.g. injected memory).
   * Edit/Write tools still require an explicit Read when this is set.
   */
  isPartialView?: boolean;
}

export interface FileStateCacheConfig {
  enabled?: boolean;
  /** Maximum number of cached file entries. Default: 100. */
  maxEntries?: number;
  /** Maximum total cached content in bytes. Default: 25 * 1024 * 1024 (25 MB). */
  maxBytes?: number;
}
