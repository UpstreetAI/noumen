import type { VirtualFs, FileEntry, FileStat, ReadOptions } from "./fs.js";

export interface SpritesFsOptions {
  /** sprites.dev API token */
  token: string;
  /** Name of the sprite container */
  spriteName: string;
  /** Base URL for sprites API (default: https://api.sprites.dev) */
  baseURL?: string;
  /** Working directory inside the sprite (default: /home/sprite) */
  workingDir?: string;
}

/**
 * Sandboxed VirtualFs backed by a remote sprites.dev container. All file
 * operations are executed over the sprites.dev HTTP API — the agent has no
 * access to the host filesystem. This is the recommended VirtualFs for
 * production deployments and untrusted agents. See `LocalFs` for an
 * unsandboxed local alternative.
 */
export class SpritesFs implements VirtualFs {
  private token: string;
  private spriteName: string;
  private baseURL: string;
  private workingDir: string;

  constructor(opts: SpritesFsOptions) {
    this.token = opts.token;
    this.spriteName = opts.spriteName;
    this.baseURL = (opts.baseURL ?? "https://api.sprites.dev").replace(
      /\/$/,
      "",
    );
    this.workingDir = opts.workingDir ?? "/home/sprite";
  }

  private fsUrl(endpoint: string, params?: Record<string, string>): string {
    const url = new URL(
      `${this.baseURL}/v1/sprites/${this.spriteName}/fs${endpoint}`,
    );
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  private resolvePath(p: string): string {
    if (p.startsWith("/")) return p;
    return `${this.workingDir}/${p}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
    };
  }

  async readFile(filePath: string, _opts?: ReadOptions): Promise<string> {
    const url = this.fsUrl("/read", { path: this.resolvePath(filePath) });
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(
        `SpritesFs readFile failed (${res.status}): ${await res.text()}`,
      );
    }
    return res.text();
  }

  async readFileBytes(filePath: string, maxBytes?: number): Promise<Buffer> {
    const url = this.fsUrl("/read", {
      path: this.resolvePath(filePath),
      binary: "true",
    });
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(
        `SpritesFs readFileBytes failed (${res.status}): ${await res.text()}`,
      );
    }
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    if (maxBytes !== undefined && buf.length > maxBytes) {
      return buf.subarray(0, maxBytes);
    }
    return buf;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const url = this.fsUrl("/write");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: this.resolvePath(filePath),
        content,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `SpritesFs writeFile failed (${res.status}): ${await res.text()}`,
      );
    }
  }

  async appendFile(filePath: string, content: string): Promise<void> {
    let existing = "";
    try {
      existing = await this.readFile(filePath);
    } catch {
      // file may not exist yet
    }
    await this.writeFile(filePath, existing + content);
  }

  async deleteFile(
    filePath: string,
    opts?: { recursive?: boolean },
  ): Promise<void> {
    const url = this.fsUrl("/remove");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: this.resolvePath(filePath),
        recursive: opts?.recursive ?? false,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `SpritesFs deleteFile failed (${res.status}): ${await res.text()}`,
      );
    }
  }

  async mkdir(
    dirPath: string,
    opts?: { recursive?: boolean },
  ): Promise<void> {
    const url = this.fsUrl("/mkdir");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: this.resolvePath(dirPath),
        recursive: opts?.recursive ?? false,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `SpritesFs mkdir failed (${res.status}): ${await res.text()}`,
      );
    }
  }

  async readdir(
    dirPath: string,
    _opts?: { recursive?: boolean },
  ): Promise<FileEntry[]> {
    const url = this.fsUrl("/readdir", { path: this.resolvePath(dirPath) });
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(
        `SpritesFs readdir failed (${res.status}): ${await res.text()}`,
      );
    }
    const data = (await res.json()) as Array<{
      name: string;
      path: string;
      is_dir: boolean;
      size?: number;
    }>;
    return data.map((entry) => ({
      name: entry.name,
      path: entry.path,
      isDirectory: entry.is_dir,
      isFile: !entry.is_dir,
      size: entry.size,
    }));
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    const url = this.fsUrl("/stat", { path: this.resolvePath(filePath) });
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(
        `SpritesFs stat failed (${res.status}): ${await res.text()}`,
      );
    }
    const data = (await res.json()) as {
      size: number;
      is_dir: boolean;
      created_at?: string;
      modified_at?: string;
    };
    return {
      size: data.size,
      isDirectory: data.is_dir,
      isFile: !data.is_dir,
      createdAt: data.created_at ? new Date(data.created_at) : undefined,
      modifiedAt: data.modified_at ? new Date(data.modified_at) : undefined,
    };
  }
}
