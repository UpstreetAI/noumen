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
