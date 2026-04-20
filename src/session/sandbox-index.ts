/**
 * Local host file mapping `sessionId -> sandboxId` so the agent can
 * reconnect to auto-created containers (Docker / E2B / Freestyle /
 * Sprites) when a session is resumed — the sandbox's own filesystem
 * may be unreachable at that point.
 *
 * Quarantined in its own module so it can be lazy-loaded from
 * `src/agent.ts`. Keeping `node:fs/promises` + `node:path` out of the
 * Agent's static import graph matters for bundlers that trace
 * dependencies (Next.js NFT, serverless-webpack, etc.) — a top-level
 * `path.resolve(cwd, ...)` with a non-constant `cwd` is the classic
 * "whole project traced unintentionally" trigger.
 */
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

function indexPath(cwd: string, sessionDir: string): string {
  return nodePath.resolve(cwd, sessionDir, ".sandbox-index.json");
}

export async function loadSandboxId(
  cwd: string,
  sessionDir: string,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const content = await nodeFs.readFile(indexPath(cwd, sessionDir), "utf-8");
    const index = JSON.parse(content) as Record<string, string>;
    return index[sessionId];
  } catch {
    return undefined;
  }
}

export async function storeSandboxId(
  cwd: string,
  sessionDir: string,
  sessionId: string,
  sandboxId: string,
): Promise<void> {
  const path = indexPath(cwd, sessionDir);
  let index: Record<string, string> = {};
  try {
    const content = await nodeFs.readFile(path, "utf-8");
    index = JSON.parse(content) as Record<string, string>;
  } catch {
    /* file doesn't exist yet */
  }
  index[sessionId] = sandboxId;
  await nodeFs.mkdir(nodePath.dirname(path), { recursive: true });
  await nodeFs.writeFile(path, JSON.stringify(index, null, 2));
}
