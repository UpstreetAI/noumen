export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size?: number;
}

export interface FileStat {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  createdAt?: Date;
  modifiedAt?: Date;
}

export interface ReadOptions {
  encoding?: BufferEncoding;
  /**
   * Maximum number of bytes to read. When set, only the first `maxBytes`
   * bytes are returned (decoded as a string). Implementations that do not
   * support this option may ignore it and return the full content.
   */
  maxBytes?: number;
}

/**
 * Sandboxed filesystem interface.
 *
 * `VirtualFs` is noumen's primary isolation boundary for file I/O. Every
 * built-in tool that touches the filesystem (ReadFile, WriteFile, EditFile)
 * delegates to this interface — the agent never accesses `node:fs` directly.
 *
 * Swap implementations to control where files live and what the agent can reach:
 * - `LocalFs`   — reads/writes on the host filesystem (no isolation, for local dev)
 * - `SpritesFs` — reads/writes inside a remote sprites.dev container (full sandbox)
 * - Custom      — implement this interface for Docker volumes, E2B, S3, in-memory, etc.
 */
export interface VirtualFs {
  readFile(path: string, opts?: ReadOptions): Promise<string>;
  /**
   * Read raw bytes from a file. Used for binary content (images, PDFs).
   * Implementations SHOULD cap the read at `maxBytes` to prevent OOM on
   * very large files. When `maxBytes` is omitted, the entire file is read.
   *
   * Returns a Buffer (Node.js) or Uint8Array.
   */
  readFileBytes?(path: string, maxBytes?: number): Promise<Buffer>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  deleteFile(path: string, opts?: { recursive?: boolean }): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  readdir(path: string, opts?: { recursive?: boolean }): Promise<FileEntry[]>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
}
