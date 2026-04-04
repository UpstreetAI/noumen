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
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  deleteFile(path: string, opts?: { recursive?: boolean }): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  readdir(path: string, opts?: { recursive?: boolean }): Promise<FileEntry[]>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
}
