import type { SwarmBackend } from "./types.js";
import type { SwarmMember, SwarmMemberConfig } from "../types.js";
import type { StreamEvent } from "../../session/types.js";
import type { ThreadConfig } from "../../thread.js";
import { Thread } from "../../thread.js";

/**
 * In-process backend: runs each swarm member as a concurrent Thread.
 */
export class InProcessBackend implements SwarmBackend {
  private threadConfig: Omit<ThreadConfig, "systemPrompt" | "model">;
  private abortControllers = new Map<string, AbortController>();

  constructor(threadConfig: Omit<ThreadConfig, "systemPrompt" | "model">) {
    this.threadConfig = threadConfig;
  }

  async *spawn(
    config: SwarmMemberConfig,
    member: SwarmMember,
  ): AsyncGenerator<StreamEvent, string, unknown> {
    const ac = new AbortController();
    this.abortControllers.set(member.id, ac);

    const childTools = config.allowedTools
      ? (this.threadConfig.tools ?? []).filter((t) =>
          config.allowedTools!.includes(t.name),
        )
      : this.threadConfig.tools;

    const thread = new Thread(
      {
        ...this.threadConfig,
        tools: childTools,
        systemPrompt: config.systemPrompt,
        model: config.model,
      },
      { cwd: (this.threadConfig as { cwd?: string }).cwd },
    );

    member.sessionId = thread.sessionId;
    let resultText = "";

    for await (const event of thread.run(config.prompt, {
      signal: ac.signal,
    })) {
      yield event;

      if (event.type === "message_complete" && event.message.content) {
        resultText += event.message.content;
      }
    }

    this.abortControllers.delete(member.id);
    return resultText;
  }

  async kill(memberId: string): Promise<void> {
    const ac = this.abortControllers.get(memberId);
    if (ac) {
      ac.abort();
      this.abortControllers.delete(memberId);
    }
  }
}
