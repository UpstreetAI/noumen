import type { SwarmMessage } from "./types.js";

/**
 * In-memory message queue for communication between swarm members.
 */
export class Mailbox {
  private messages: SwarmMessage[] = [];
  private listeners = new Map<string, Array<(msg: SwarmMessage) => void>>();

  /**
   * Send a message from one member to another.
   */
  send(from: string, to: string, content: string): void {
    const msg: SwarmMessage = {
      from,
      to,
      content,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(msg);

    const handlers = this.listeners.get(to);
    if (handlers) {
      for (const handler of handlers) {
        handler(msg);
      }
    }
  }

  /**
   * Broadcast a message to all members except the sender.
   */
  broadcast(from: string, content: string, memberNames: string[]): void {
    for (const name of memberNames) {
      if (name !== from) {
        this.send(from, name, content);
      }
    }
  }

  /**
   * Get all messages sent to a specific member.
   */
  getMessagesFor(memberName: string): SwarmMessage[] {
    return this.messages.filter((m) => m.to === memberName);
  }

  /**
   * Get all unread messages for a member since the last check.
   */
  getNewMessagesFor(memberName: string, since: string): SwarmMessage[] {
    return this.messages.filter(
      (m) => m.to === memberName && m.timestamp > since,
    );
  }

  /**
   * Register a listener for incoming messages to a member.
   */
  onMessage(
    memberName: string,
    handler: (msg: SwarmMessage) => void,
  ): () => void {
    const existing = this.listeners.get(memberName) ?? [];
    existing.push(handler);
    this.listeners.set(memberName, existing);

    return () => {
      const handlers = this.listeners.get(memberName);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    };
  }

  /**
   * Get all messages in the mailbox.
   */
  getAllMessages(): SwarmMessage[] {
    return [...this.messages];
  }
}
