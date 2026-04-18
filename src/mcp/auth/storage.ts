import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TokenStorage, OAuthTokenData } from "./types.js";
import {
  DEFAULT_DOT_DIRS,
  createDotDirResolver,
  type DotDirResolver,
} from "../../config/dot-dirs.js";

/**
 * In-memory token storage. Suitable for tests, short-lived processes,
 * and situations where persistence across restarts is not needed.
 */
export class InMemoryTokenStorage implements TokenStorage {
  private store = new Map<string, OAuthTokenData>();

  async load(serverKey: string): Promise<OAuthTokenData | undefined> {
    return this.store.get(serverKey);
  }

  async save(serverKey: string, data: OAuthTokenData): Promise<void> {
    this.store.set(serverKey, data);
  }

  async delete(serverKey: string): Promise<void> {
    this.store.delete(serverKey);
  }
}

/**
 * File-backed token storage. Persists all server tokens to a single JSON
 * file so they survive process restarts. Each server key maps to its own
 * entry in the file.
 *
 * Reads walk all candidate dot-dirs in preference order, so tokens written
 * by an older install under `.claude/` keep working; writes always target
 * the resolver's canonical write dir (default `.noumen/`).
 */
export class FileTokenStorage implements TokenStorage {
  /** Explicit path override, if provided. */
  private explicitPath?: string;
  private resolver: DotDirResolver;
  private homeBase: string;

  constructor(filePath?: string, resolver?: DotDirResolver) {
    this.explicitPath = filePath;
    this.resolver = resolver ?? createDotDirResolver(DEFAULT_DOT_DIRS);
    this.homeBase = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  }

  private get writePath(): string {
    if (this.explicitPath) return this.explicitPath;
    return this.resolver.joinWrite(this.homeBase, "mcp-oauth-tokens.json");
  }

  private readCandidatePaths(): string[] {
    if (this.explicitPath) return [this.explicitPath];
    return this.resolver.joinRead(this.homeBase, "mcp-oauth-tokens.json");
  }

  async load(serverKey: string): Promise<OAuthTokenData | undefined> {
    const all = await this.readAll();
    return all[serverKey];
  }

  async save(serverKey: string, data: OAuthTokenData): Promise<void> {
    const all = await this.readAll();
    all[serverKey] = data;
    await this.writeAll(all);
  }

  async delete(serverKey: string): Promise<void> {
    const all = await this.readAll();
    delete all[serverKey];
    await this.writeAll(all);
  }

  private async readAll(): Promise<Record<string, OAuthTokenData>> {
    for (const candidate of this.readCandidatePaths()) {
      try {
        const raw = await fs.readFile(candidate, "utf-8");
        return JSON.parse(raw) as Record<string, OAuthTokenData>;
      } catch {
        // keep walking
      }
    }
    return {};
  }

  private async writeAll(data: Record<string, OAuthTokenData>): Promise<void> {
    const target = this.writePath;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(data, null, 2), "utf-8");
  }
}
