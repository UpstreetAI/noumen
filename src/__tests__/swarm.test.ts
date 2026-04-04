import { describe, it, expect, vi } from "vitest";
import { Mailbox } from "../swarm/mailbox.js";
import { SwarmManager } from "../swarm/manager.js";
import type { SwarmBackend } from "../swarm/backends/types.js";
import type { SwarmMember, SwarmMemberConfig } from "../swarm/types.js";
import type { StreamEvent } from "../session/types.js";

function fakeBackend(result = "ok"): SwarmBackend {
  return {
    async *spawn(
      _config: SwarmMemberConfig,
      _member: SwarmMember,
    ): AsyncGenerator<StreamEvent, string, unknown> {
      return result;
    },
    async kill(): Promise<void> {},
  };
}

describe("Mailbox", () => {
  it("send stores message with timestamp", () => {
    const box = new Mailbox();
    box.send("a", "b", "hello");
    const msgs = box.getAllMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ from: "a", to: "b", content: "hello" });
    expect(msgs[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("getMessagesFor returns only messages for target", () => {
    const box = new Mailbox();
    box.send("x", "alice", "1");
    box.send("y", "bob", "2");
    box.send("z", "alice", "3");
    expect(box.getMessagesFor("alice").map((m) => m.content)).toEqual(["1", "3"]);
    expect(box.getMessagesFor("bob").map((m) => m.content)).toEqual(["2"]);
  });

  it("getNewMessagesFor filters by timestamp", async () => {
    const box = new Mailbox();
    box.send("a", "t", "old");
    const since = box.getAllMessages()[0].timestamp;
    await new Promise((r) => setTimeout(r, 5));
    box.send("b", "t", "new");
    expect(box.getNewMessagesFor("t", since).map((m) => m.content)).toEqual(["new"]);
  });

  it("broadcast excludes sender", () => {
    const box = new Mailbox();
    box.broadcast("a", "hi", ["a", "b", "c"]);
    const all = box.getAllMessages();
    expect(all).toHaveLength(2);
    expect(all.every((m) => m.from === "a")).toBe(true);
    expect(new Set(all.map((m) => m.to))).toEqual(new Set(["b", "c"]));
  });

  it("getAllMessages returns a copy", () => {
    const box = new Mailbox();
    box.send("1", "2", "x");
    const snap = box.getAllMessages();
    snap.push({
      from: "bad",
      to: "bad",
      content: "bad",
      timestamp: new Date().toISOString(),
    });
    expect(box.getAllMessages()).toHaveLength(1);
  });

  it("onMessage listener fires", () => {
    const box = new Mailbox();
    const fn = vi.fn();
    box.onMessage("bob", fn);
    box.send("alice", "bob", "hey");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({ from: "alice", to: "bob", content: "hey" }),
    );
  });
});

describe("SwarmManager", () => {
  it("spawn assigns UUID, sets running then completed, emits start and complete", async () => {
    const mgr = new SwarmManager(fakeBackend("result-text"));
    const events: string[] = [];
    mgr.onEvent((e) => events.push(e.type));

    const id = await mgr.spawn({ name: "worker", prompt: "do" });
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    await mgr.waitForAll();
    const m = mgr.getMember(id)!;
    expect(m.status).toBe("completed");
    expect(m.result).toBe("result-text");
    expect(events).toEqual(["swarm_member_start", "swarm_member_complete"]);
  });

  it("failed member has status and error", async () => {
    const backend: SwarmBackend = {
      async *spawn(): AsyncGenerator<StreamEvent, string, unknown> {
        throw new Error("boom");
      },
      async kill(): Promise<void> {},
    };
    const mgr = new SwarmManager(backend);
    const errors: Error[] = [];
    mgr.onEvent((e) => {
      if (e.type === "swarm_member_failed" && e.error) errors.push(e.error);
    });

    const id = await mgr.spawn({ name: "f", prompt: "p" });
    await mgr.waitForAll();
    const m = mgr.getMember(id)!;
    expect(m.status).toBe("failed");
    expect(m.error?.message).toBe("boom");
    expect(errors[0]?.message).toBe("boom");
  });

  it("kill sets status to killed", async () => {
    const backend: SwarmBackend = {
      async *spawn(): AsyncGenerator<StreamEvent, string, unknown> {
        await new Promise<void>(() => {});
        return "done";
      },
      async kill(): Promise<void> {},
    };
    const mgr = new SwarmManager(backend);
    const id = await mgr.spawn({ name: "k", prompt: "p" });
    expect(mgr.getMember(id)!.status).toBe("running");
    await mgr.kill(id);
    expect(mgr.getMember(id)!.status).toBe("killed");
  });

  it("waitForAll resolves when all members finish", async () => {
    const mgr = new SwarmManager(fakeBackend());
    await mgr.spawn({ name: "a", prompt: "1" });
    await mgr.spawn({ name: "b", prompt: "2" });
    await expect(mgr.waitForAll()).resolves.toBeUndefined();
  });

  it("sendMessage delegates to mailbox and emits swarm_message", async () => {
    const mgr = new SwarmManager(fakeBackend());
    const id = await mgr.spawn({ name: "alice", prompt: "p" });
    await mgr.waitForAll();
    const msgs: Array<{ type: string; content?: string }> = [];
    mgr.onEvent((e) => msgs.push({ type: e.type, content: e.content }));

    mgr.sendMessage(id, "bob", "hello bob");
    const inbox = mgr.getMailbox().getMessagesFor("bob");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ from: id, to: "bob", content: "hello bob" });
    expect(msgs.at(-1)).toEqual({
      type: "swarm_message",
      content: "hello bob",
    });
  });

  it("maxConcurrent limits parallel backend runs", async () => {
    let active = 0;
    let peak = 0;
    const backend: SwarmBackend = {
      async *spawn(): AsyncGenerator<StreamEvent, string, unknown> {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 25));
        active--;
        return "x";
      },
      async kill(): Promise<void> {},
    };
    const mgr = new SwarmManager(backend, { maxConcurrent: 2 });
    await mgr.spawnAll([
      { name: "m0", prompt: "0" },
      { name: "m1", prompt: "1" },
      { name: "m2", prompt: "2" },
    ]);
    await mgr.waitForAll();
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
  });
});
