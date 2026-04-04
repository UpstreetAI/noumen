import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { Agent } from "../agent.js";
import type { Thread } from "../thread.js";
import type { StreamEvent } from "../session/types.js";
import type { PermissionResponse } from "../permissions/types.js";
import type { MergedConfig } from "./config.js";

interface PromiseResolver<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

interface SessionEntry {
  thread: Thread;
  abort: AbortController;
  pendingPermission: PromiseResolver<PermissionResponse> | null;
  pendingInput: PromiseResolver<string> | null;
  running: boolean;
}

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function serializeEvent(event: StreamEvent): Record<string, unknown> {
  if (event.type === "error") {
    return { type: "error", error: { message: event.error.message, name: event.error.name } };
  }
  if (event.type === "retry_exhausted") {
    return { ...event, error: { message: event.error.message, name: event.error.name } };
  }
  if (event.type === "retry_attempt") {
    return { ...event, error: { message: event.error.message, name: event.error.name } };
  }
  return event as unknown as Record<string, unknown>;
}

/**
 * Run the agent in headless mode: bidirectional NDJSON over stdin/stdout.
 *
 * Inbound commands (stdin, one JSON per line):
 *   { type: "prompt", text, sessionId?, maxTurns? }
 *   { type: "permission_response", sessionId, allow, updatedInput? }
 *   { type: "input_response", sessionId, answer }
 *   { type: "abort", sessionId }
 *
 * Outbound events (stdout, one JSON per line):
 *   { type: "ready" }
 *   { type: "session_created", sessionId }
 *   { type: "session_done", sessionId }
 *   All StreamEvent types with an added `sessionId` field
 */
export async function runHeadless(code: Agent, _config: MergedConfig): Promise<void> {
  await code.init();

  const sessions = new Map<string, SessionEntry>();

  emit({ type: "ready" });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let cmd: Record<string, unknown>;
    try {
      cmd = JSON.parse(line);
    } catch {
      emit({ type: "error", error: { message: "Invalid JSON", name: "ParseError" } });
      continue;
    }

    const cmdType = cmd.type as string;

    if (cmdType === "prompt") {
      const text = cmd.text as string;
      if (!text) {
        emit({ type: "error", error: { message: "Missing required field: text", name: "ValidationError" } });
        continue;
      }

      const sessionId = (cmd.sessionId as string) ?? randomUUID();
      const existing = sessions.get(sessionId);

      if (existing?.running) {
        emit({ type: "error", error: { message: "Session is still running", name: "ConflictError" }, sessionId });
        continue;
      }

      const abort = new AbortController();

      const permissionHandler = (req: import("../permissions/types.js").PermissionRequest): Promise<PermissionResponse> => {
        const entry = sessions.get(sessionId);
        if (!entry) return Promise.reject(new Error("Session not found"));
        return new Promise<PermissionResponse>((resolve, reject) => {
          entry.pendingPermission = { resolve, reject };
        });
      };

      const userInputHandler = (question: string): Promise<string> => {
        const entry = sessions.get(sessionId);
        if (!entry) return Promise.reject(new Error("Session not found"));
        emit({ ...({} as Record<string, unknown>), type: "user_input_request", sessionId, question });
        return new Promise<string>((resolve, reject) => {
          entry.pendingInput = { resolve, reject };
        });
      };

      let thread: Thread;
      if (existing) {
        existing.abort = abort;
        existing.running = true;
        thread = existing.thread;
      } else {
        thread = code.createThread({
          sessionId,
          permissionHandler,
          userInputHandler,
        });
        sessions.set(sessionId, {
          thread,
          abort,
          pendingPermission: null,
          pendingInput: null,
          running: true,
        });
      }

      emit({ type: "session_created", sessionId });

      const maxTurns = cmd.maxTurns as number | undefined;

      (async () => {
        try {
          for await (const event of thread.run(text, { signal: abort.signal, maxTurns })) {
            emit({ ...serializeEvent(event), sessionId });
          }
        } catch (err) {
          if ((err as Error).name !== "AbortError") {
            const e = err instanceof Error ? err : new Error(String(err));
            emit({ type: "error", error: { message: e.message, name: e.name }, sessionId });
          }
        } finally {
          const entry = sessions.get(sessionId);
          if (entry) entry.running = false;
          emit({ type: "session_done", sessionId });
        }
      })();

      continue;
    }

    if (cmdType === "permission_response") {
      const sessionId = cmd.sessionId as string;
      const entry = sessions.get(sessionId);
      if (!entry?.pendingPermission) continue;
      const { sessionId: _sid, type: _type, ...response } = cmd;
      entry.pendingPermission.resolve(response as unknown as PermissionResponse);
      entry.pendingPermission = null;
      continue;
    }

    if (cmdType === "input_response") {
      const sessionId = cmd.sessionId as string;
      const entry = sessions.get(sessionId);
      if (!entry?.pendingInput) continue;
      entry.pendingInput.resolve((cmd.answer as string) ?? "");
      entry.pendingInput = null;
      continue;
    }

    if (cmdType === "abort") {
      const sessionId = cmd.sessionId as string;
      const entry = sessions.get(sessionId);
      if (entry) {
        entry.abort.abort();
        if (entry.pendingPermission) {
          entry.pendingPermission.reject(new Error("Session aborted"));
          entry.pendingPermission = null;
        }
        if (entry.pendingInput) {
          entry.pendingInput.reject(new Error("Session aborted"));
          entry.pendingInput = null;
        }
      }
      continue;
    }

    emit({ type: "error", error: { message: `Unknown command type: ${cmdType}`, name: "ValidationError" } });
  }

  await code.close();
}
