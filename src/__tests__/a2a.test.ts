import { describe, it, expect } from "vitest";
import { buildAgentCard } from "../a2a/agent-card.js";
import { A2A_METHODS, type TaskStatus, type Part, type TextPart } from "../a2a/types.js";

describe("A2A Agent Card", () => {
  it("builds a card with required fields", () => {
    const card = buildAgentCard({
      name: "TestAgent",
      url: "https://example.com",
    });

    expect(card.name).toBe("TestAgent");
    expect(card.url).toBe("https://example.com");
    expect(card.version).toBe("0.1.0");
    expect(card.capabilities?.streaming).toBe(true);
    expect(card.defaultInputModes).toContain("text");
    expect(card.defaultOutputModes).toContain("text");
  });

  it("includes default coding skill", () => {
    const card = buildAgentCard({
      name: "TestAgent",
      url: "https://example.com",
    });

    expect(card.skills).toHaveLength(1);
    expect(card.skills![0].id).toBe("coding");
  });

  it("allows custom skills", () => {
    const card = buildAgentCard({
      name: "TestAgent",
      url: "https://example.com",
      skills: [
        { id: "review", name: "Code Review", tags: ["review"] },
      ],
    });

    expect(card.skills).toHaveLength(1);
    expect(card.skills![0].id).toBe("review");
  });

  it("includes provider info when set", () => {
    const card = buildAgentCard({
      name: "TestAgent",
      url: "https://example.com",
      provider: { organization: "Acme Corp", url: "https://acme.example.com" },
    });

    expect(card.provider?.organization).toBe("Acme Corp");
  });
});

describe("A2A method constants", () => {
  it("defines task methods", () => {
    expect(A2A_METHODS.TASKS_SEND).toBe("tasks/send");
    expect(A2A_METHODS.TASKS_SEND_SUBSCRIBE).toBe("tasks/sendSubscribe");
    expect(A2A_METHODS.TASKS_GET).toBe("tasks/get");
    expect(A2A_METHODS.TASKS_CANCEL).toBe("tasks/cancel");
  });
});

describe("A2A types", () => {
  it("TaskStatus enum values are valid strings", () => {
    const statuses: TaskStatus[] = [
      "submitted",
      "working",
      "input-required",
      "completed",
      "failed",
      "canceled",
    ];
    expect(statuses).toHaveLength(6);
  });

  it("TextPart has required fields", () => {
    const part: TextPart = { type: "text", text: "hello" };
    expect(part.type).toBe("text");
    expect(part.text).toBe("hello");
  });
});
