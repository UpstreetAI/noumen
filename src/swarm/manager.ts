import type {
  SwarmConfig,
  SwarmMember,
  SwarmMemberConfig,
  SwarmMemberStatus,
  SwarmStatus,
  SwarmEvents,
} from "./types.js";
import type { SwarmBackend } from "./backends/types.js";
import type { StreamEvent } from "../session/types.js";
import { Mailbox } from "./mailbox.js";
import { generateUUID } from "../utils/uuid.js";

/**
 * Orchestrates multiple agent threads running in parallel.
 */
export class SwarmManager {
  private members = new Map<string, SwarmMember>();
  private backend: SwarmBackend;
  private mailbox = new Mailbox();
  private config: SwarmConfig;
  private runningTasks = new Map<string, Promise<void>>();
  private eventHandlers: Array<(event: SwarmEvents) => void> = [];

  constructor(backend: SwarmBackend, config?: SwarmConfig) {
    this.backend = backend;
    this.config = config ?? {};
  }

  /**
   * Register a handler for swarm lifecycle events.
   */
  onEvent(handler: (event: SwarmEvents) => void): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx !== -1) this.eventHandlers.splice(idx, 1);
    };
  }

  private emit(event: SwarmEvents): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  /**
   * Spawn a new swarm member. Returns the member ID.
   */
  async spawn(config: SwarmMemberConfig): Promise<string> {
    const id = generateUUID();
    const member: SwarmMember = {
      id,
      name: config.name,
      status: "pending",
    };
    this.members.set(id, member);

    const maxConcurrent = this.config.maxConcurrent ?? 4;
    const running = Array.from(this.members.values()).filter(
      (m) => m.status === "running",
    ).length;

    if (running >= maxConcurrent) {
      // Wait for a slot
      await this.waitForSlot(maxConcurrent);
    }

    member.status = "running";
    this.emit({
      type: "swarm_member_start",
      memberId: id,
      memberName: config.name,
    });

    const task = this.runMember(config, member);
    this.runningTasks.set(id, task);

    return id;
  }

  private async runMember(
    config: SwarmMemberConfig,
    member: SwarmMember,
  ): Promise<void> {
    try {
      const gen = this.backend.spawn(config, member);
      let next = await gen.next();
      while (!next.done) {
        next = await gen.next();
      }
      member.result = next.value;
      member.status = "completed";
      this.emit({
        type: "swarm_member_complete",
        memberId: member.id,
        memberName: member.name,
        content: member.result,
      });
    } catch (err) {
      member.error = err instanceof Error ? err : new Error(String(err));
      member.status = "failed";
      this.emit({
        type: "swarm_member_failed",
        memberId: member.id,
        memberName: member.name,
        error: member.error,
      });
    } finally {
      this.runningTasks.delete(member.id);
    }
  }

  /**
   * Spawn multiple members concurrently. Returns their IDs.
   */
  async spawnAll(configs: SwarmMemberConfig[]): Promise<string[]> {
    const ids: string[] = [];
    for (const config of configs) {
      ids.push(await this.spawn(config));
    }
    return ids;
  }

  /**
   * Send a message between swarm members.
   */
  sendMessage(from: string, to: string, content: string): void {
    this.mailbox.send(from, to, content);
    this.emit({
      type: "swarm_message",
      memberId: to,
      memberName: this.getMemberName(to),
      content,
    });
  }

  /**
   * Kill a running member.
   */
  async kill(memberId: string): Promise<void> {
    const member = this.members.get(memberId);
    if (!member || member.status !== "running") return;

    await this.backend.kill(memberId);
    member.status = "killed";
    this.runningTasks.delete(memberId);
  }

  /**
   * Wait for all running members to complete.
   */
  async waitForAll(): Promise<void> {
    while (this.runningTasks.size > 0) {
      await Promise.race(this.runningTasks.values());
    }
  }

  /**
   * Get current swarm status.
   */
  getStatus(): SwarmStatus {
    return {
      members: Array.from(this.members.values()),
      messages: this.mailbox.getAllMessages(),
    };
  }

  /**
   * Get a specific member.
   */
  getMember(id: string): SwarmMember | undefined {
    return this.members.get(id);
  }

  /**
   * Get the mailbox for direct access.
   */
  getMailbox(): Mailbox {
    return this.mailbox;
  }

  private getMemberName(id: string): string {
    return this.members.get(id)?.name ?? id;
  }

  private async waitForSlot(maxConcurrent: number): Promise<void> {
    while (true) {
      const running = Array.from(this.members.values()).filter(
        (m) => m.status === "running",
      ).length;
      if (running < maxConcurrent) return;
      if (this.runningTasks.size > 0) {
        await Promise.race(this.runningTasks.values());
      } else {
        break;
      }
    }
  }
}
