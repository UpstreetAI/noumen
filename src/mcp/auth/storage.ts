import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TokenStorage, OAuthTokenData } from "./types.js";

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
 */
export class FileTokenStorage implements TokenStorage {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".noumen",
        "mcp-oauth-tokens.json",
      );
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
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      return JSON.parse(raw) as Record<string, OAuthTokenData>;
    } catch {
      return {};
    }
  }

  private async writeAll(data: Record<string, OAuthTokenData>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }
}
