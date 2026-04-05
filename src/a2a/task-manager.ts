/**
 * A2A Task Manager: maps A2A task lifecycle to noumen sessions/threads.
 */

import type { Agent } from "../agent.js";
import type { Thread } from "../thread.js";
import type { StreamEvent } from "../session/types.js";
import { contentToString } from "../utils/content.js";
import { generateUUID } from "../utils/uuid.js";
import type {
  Task,
  TaskState,
  TaskStatus,
  Message,
  Part,
  TextPart,
  Artifact,
  TaskStreamEvent,
  TaskSendParams,
} from "./types.js";

interface ManagedTask {
  task: Task;
  thread: Thread;
  abortController: AbortController;
}

export class TaskManager {
  private tasks = new Map<string, ManagedTask>();
  private code: Agent;

  constructor(code: Agent) {
    this.code = code;
  }

  /**
   * Create a task, start running it, and return the task immediately.
   * Use `getTask` to poll status or `streamTask` for SSE.
   */
  async sendTask(params: TaskSendParams): Promise<Task> {
    const taskId = params.id ?? generateUUID();

    const thread = await this.code.createThread({
      sessionId: params.sessionId,
    });

    const task: Task = {
      id: taskId,
      sessionId: thread.sessionId,
      status: { state: "submitted", timestamp: new Date().toISOString() },
      history: [params.message],
      artifacts: [],
    };

    const abortController = new AbortController();
    this.tasks.set(taskId, { task, thread, abortController });

    const prompt = this.messageToPrompt(params.message);
    this.runTask(taskId, prompt);

    return task;
  }

  /**
   * Stream task events as an async generator (for SSE).
   */
  async *sendTaskSubscribe(
    params: TaskSendParams,
  ): AsyncGenerator<TaskStreamEvent> {
    const taskId = params.id ?? generateUUID();

    const thread = await this.code.createThread({
      sessionId: params.sessionId,
    });

    const task: Task = {
      id: taskId,
      sessionId: thread.sessionId,
      status: { state: "submitted", timestamp: new Date().toISOString() },
      history: [params.message],
      artifacts: [],
    };

    const abortController = new AbortController();
    this.tasks.set(taskId, { task, thread, abortController });

    yield {
      type: "status",
      taskId,
      status: task.status,
      final: false,
    };

    task.status = { state: "working", timestamp: new Date().toISOString() };
    yield {
      type: "status",
      taskId,
      status: task.status,
      final: false,
    };

    const prompt = this.messageToPrompt(params.message);
    const textParts: string[] = [];

    try {
      for await (const event of thread.run(prompt, {
        signal: abortController.signal,
      })) {
        const streamEvent = this.mapStreamEvent(taskId, task, event, textParts);
        if (streamEvent) yield streamEvent;
      }

      // Finalize
      if (textParts.length > 0) {
        const artifact: Artifact = {
          name: "response",
          parts: [{ type: "text", text: textParts.join("") }],
          lastChunk: true,
        };
        task.artifacts = [artifact];
        yield { type: "artifact", taskId, artifact };
      }

      task.status = { state: "completed", timestamp: new Date().toISOString() };
      yield { type: "status", taskId, status: task.status, final: true };
    } catch (err) {
      task.status = {
        state: "failed",
        timestamp: new Date().toISOString(),
        message: {
          role: "agent",
          parts: [
            {
              type: "text",
              text: err instanceof Error ? err.message : String(err),
            },
          ],
        },
      };
      yield { type: "status", taskId, status: task.status, final: true };
    }
  }

  getTask(taskId: string): Task | null {
    return this.tasks.get(taskId)?.task ?? null;
  }

  cancelTask(taskId: string): boolean {
    const managed = this.tasks.get(taskId);
    if (!managed) return false;

    managed.abortController.abort();
    managed.task.status = {
      state: "canceled",
      timestamp: new Date().toISOString(),
    };
    return true;
  }

  private async runTask(taskId: string, prompt: string): Promise<void> {
    const managed = this.tasks.get(taskId);
    if (!managed) return;

    managed.task.status = {
      state: "working",
      timestamp: new Date().toISOString(),
    };

    try {
      const textParts: string[] = [];
      for await (const event of managed.thread.run(prompt, {
        signal: managed.abortController.signal,
      })) {
        if (event.type === "text_delta") {
          textParts.push(event.text);
        }
        if (event.type === "user_input_request") {
          managed.task.status = {
            state: "input-required",
            timestamp: new Date().toISOString(),
          };
        }
      }

      if (textParts.length > 0) {
        managed.task.artifacts = [
          {
            name: "response",
            parts: [{ type: "text", text: textParts.join("") }],
            lastChunk: true,
          },
        ];
      }

      managed.task.status = {
        state: "completed",
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      managed.task.status = {
        state: "failed",
        timestamp: new Date().toISOString(),
        message: {
          role: "agent",
          parts: [
            {
              type: "text",
              text: err instanceof Error ? err.message : String(err),
            },
          ],
        },
      };
    }
  }

  private mapStreamEvent(
    taskId: string,
    task: Task,
    event: StreamEvent,
    textParts: string[],
  ): TaskStreamEvent | null {
    switch (event.type) {
      case "text_delta":
        textParts.push(event.text);
        return null; // Text accumulates into artifact at end

      case "user_input_request":
        task.status = {
          state: "input-required",
          timestamp: new Date().toISOString(),
        };
        return {
          type: "status",
          taskId,
          status: task.status,
          final: false,
        };

      case "error":
        task.status = {
          state: "failed",
          timestamp: new Date().toISOString(),
          message: {
            role: "agent",
            parts: [{ type: "text", text: event.error.message }],
          },
        };
        return {
          type: "status",
          taskId,
          status: task.status,
          final: true,
        };

      default:
        return null;
    }
  }

  private messageToPrompt(message: Message): string {
    return message.parts
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
}
