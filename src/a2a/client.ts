/**
 * A2A client for calling remote A2A agents.
 *
 * Enables noumen agents to discover and delegate work to other A2A agents.
 */

import type {
  AgentCard,
  Task,
  Message,
  TaskSendParams,
  TaskStreamEvent,
} from "./types.js";
import { A2A_METHODS } from "./types.js";
import { formatRequest, type JsonRpcResponse } from "../jsonrpc/index.js";

export interface A2AClientOptions {
  /** Override headers for all requests. */
  headers?: Record<string, string>;
  /** Bearer token for authentication. */
  token?: string;
}

export class A2AClient {
  private agentUrl: string;
  private headers: Record<string, string>;

  constructor(agentUrl: string, options?: A2AClientOptions) {
    this.agentUrl = agentUrl.replace(/\/+$/, "");
    this.headers = {
      "Content-Type": "application/json",
      ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options?.headers ?? {}),
    };
  }

  /**
   * Discover the remote agent's capabilities via its Agent Card.
   */
  async getAgentCard(): Promise<AgentCard> {
    const res = await fetch(
      `${this.agentUrl}/.well-known/agent.json`,
      { headers: this.headers },
    );
    if (!res.ok) {
      throw new Error(`Failed to fetch agent card: ${res.status}`);
    }
    return res.json() as Promise<AgentCard>;
  }

  /**
   * Send a task to the remote agent (non-streaming).
   */
  async sendTask(params: TaskSendParams): Promise<Task> {
    const rpc = formatRequest(1, A2A_METHODS.TASKS_SEND, params);
    const res = await fetch(this.agentUrl, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(rpc),
    });
    const response = (await res.json()) as JsonRpcResponse;
    if ("error" in response) {
      throw new Error(response.error.message);
    }
    return response.result as Task;
  }

  /**
   * Send a task and subscribe to streaming updates via SSE.
   */
  async *sendTaskSubscribe(
    params: TaskSendParams,
  ): AsyncGenerator<TaskStreamEvent> {
    const rpc = formatRequest(1, A2A_METHODS.TASKS_SEND_SUBSCRIBE, params);
    const res = await fetch(this.agentUrl, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(rpc),
    });

    if (!res.ok) {
      throw new Error(`A2A streaming request failed: ${res.status}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (!data) continue;
            try {
              const parsed = JSON.parse(data) as JsonRpcResponse;
              if ("result" in parsed) {
                yield parsed.result as TaskStreamEvent;
              }
            } catch {
              // Skip malformed SSE data
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Get the current state of a task.
   */
  async getTask(taskId: string): Promise<Task> {
    const rpc = formatRequest(1, A2A_METHODS.TASKS_GET, { id: taskId });
    const res = await fetch(this.agentUrl, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(rpc),
    });
    const response = (await res.json()) as JsonRpcResponse;
    if ("error" in response) {
      throw new Error(response.error.message);
    }
    return response.result as Task;
  }

  /**
   * Cancel a running task.
   */
  async cancelTask(taskId: string): Promise<void> {
    const rpc = formatRequest(1, A2A_METHODS.TASKS_CANCEL, { id: taskId });
    const res = await fetch(this.agentUrl, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(rpc),
    });
    const response = (await res.json()) as JsonRpcResponse;
    if ("error" in response) {
      throw new Error(response.error.message);
    }
  }

  /**
   * Helper: send a simple text message and return the task.
   */
  async ask(text: string, sessionId?: string): Promise<Task> {
    return this.sendTask({
      sessionId,
      message: {
        role: "user",
        parts: [{ type: "text", text }],
      },
    });
  }
}
