import type { AIProvider } from "./providers/types.js";
import type { VirtualFs } from "./virtual/fs.js";
import type { VirtualComputer } from "./virtual/computer.js";
import type { DiagnoseCheckResult } from "./agent.js";

// ---------------------------------------------------------------------------
// timedCheck utility
// ---------------------------------------------------------------------------

export async function timedCheck<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<{ value: T; latencyMs: number }> {
  const start = performance.now();
  const value = await Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
  return { value, latencyMs: Math.round(performance.now() - start) };
}

export function formatDiagError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Individual health checks
// ---------------------------------------------------------------------------

export async function checkProviderHealth(
  provider: AIProvider,
  model: string | undefined,
  timeoutMs: number,
): Promise<DiagnoseCheckResult & { model?: string }> {
  try {
    const { latencyMs } = await timedCheck(async () => {
      const stream = provider.chat({
        model: model as string,
        messages: [{ role: "user", content: "Say ok" }],
        tools: [],
        system: "",
      });
      for await (const _ of stream) { break; }
    }, timeoutMs);
    return { ok: true, latencyMs, model };
  } catch (err) {
    return { ok: false, latencyMs: 0, error: formatDiagError(err), model };
  }
}

export async function checkVirtualFs(
  fs: VirtualFs,
  timeoutMs: number,
): Promise<DiagnoseCheckResult> {
  try {
    const { latencyMs } = await timedCheck(async () => fs.exists("/"), timeoutMs);
    return { ok: true, latencyMs };
  } catch (err) {
    return { ok: false, latencyMs: 0, error: formatDiagError(err) };
  }
}

export async function checkVirtualComputer(
  computer: VirtualComputer,
  timeoutMs: number,
): Promise<DiagnoseCheckResult> {
  try {
    const { value: cmd, latencyMs } = await timedCheck(
      async () => computer.executeCommand("echo ok"),
      timeoutMs,
    );
    if (cmd.exitCode === 0) {
      return { ok: true, latencyMs };
    }
    return { ok: false, latencyMs, warning: "Shell returned non-zero" };
  } catch (err) {
    return { ok: false, latencyMs: 0, error: formatDiagError(err) };
  }
}

export async function checkSandboxRuntime(): Promise<
  DiagnoseCheckResult & { platform?: string }
> {
  try {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const supported = SandboxManager.isSupportedPlatform();
    const deps = SandboxManager.checkDependencies();
    const hasErrors = deps.errors.length > 0;
    if (supported && !hasErrors) {
      return {
        ok: true,
        latencyMs: 0,
        platform: process.platform,
        ...(deps.warnings.length > 0 && { warning: deps.warnings.join("; ") }),
      };
    }
    const reasons: string[] = [];
    if (!supported) reasons.push(`platform ${process.platform} not supported`);
    reasons.push(...deps.errors);
    return {
      ok: false,
      latencyMs: 0,
      warning: reasons.join("; "),
      platform: process.platform,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: 0,
      warning: `@anthropic-ai/sandbox-runtime not available: ${formatDiagError(err)}`,
      platform: process.platform,
    };
  }
}

// ---------------------------------------------------------------------------
// Status summarizers
// ---------------------------------------------------------------------------

export interface McpConnectionStatus {
  name: string;
  status: string;
  toolCount?: number;
}

export function summarizeMcpStatus(
  statuses: McpConnectionStatus[],
): Record<string, DiagnoseCheckResult & { status?: string; toolCount?: number }> {
  const result: Record<string, DiagnoseCheckResult & { status?: string; toolCount?: number }> = {};
  for (const s of statuses) {
    const ok = s.status === "connected";
    result[s.name] = {
      ok,
      latencyMs: 0,
      status: s.status,
      toolCount: s.toolCount,
      ...(!ok && s.status === "needs-auth"
        ? { warning: "Requires OAuth authentication" }
        : {}),
      ...(!ok && s.status === "failed"
        ? { error: "Connection failed" }
        : {}),
    };
  }
  return result;
}

export interface LspServerStatus {
  name: string;
  state: string;
}

export function summarizeLspStatus(
  statuses: LspServerStatus[],
): Record<string, DiagnoseCheckResult & { state?: string }> {
  const result: Record<string, DiagnoseCheckResult & { state?: string }> = {};
  for (const s of statuses) {
    result[s.name] = {
      ok: s.state === "running",
      latencyMs: 0,
      state: s.state,
      ...(s.state !== "running" && s.state !== "idle"
        ? { warning: `Server state: ${s.state}` }
        : {}),
    };
  }
  return result;
}
