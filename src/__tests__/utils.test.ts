import { describe, it, expect } from "vitest";
import { estimateTokens, estimateMessagesTokens } from "../utils/tokens.js";
import { jsonStringify, parseJSONL } from "../utils/json.js";
import { generateUUID } from "../utils/uuid.js";

describe("estimateTokens", () => {
  it("estimates roughly 1 token per 4 chars", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });

  it("rounds up", () => {
    expect(estimateTokens("abc")).toBe(1); // ceil(3/4) = 1
    expect(estimateTokens("abcde")).toBe(2); // ceil(5/4) = 2
  });
});

describe("estimateMessagesTokens", () => {
  it("sums token estimates across messages with overhead", () => {
    const msgs = [
      { role: "user", content: "abcdefgh" }, // 2 tokens + 4 overhead
      { role: "assistant", content: "abcd" }, // 1 token + 4 overhead
    ];
    const result = estimateMessagesTokens(msgs);
    expect(result).toBe(2 + 4 + 1 + 4);
  });

  it("handles non-string content via JSON.stringify", () => {
    const msgs = [{ role: "user", content: { key: "value" } }];
    const result = estimateMessagesTokens(msgs);
    const jsonStr = JSON.stringify({ key: "value" });
    expect(result).toBe(Math.ceil(jsonStr.length / 4) + 4);
  });
});

describe("jsonStringify", () => {
  it("serializes objects to JSON", () => {
    expect(jsonStringify({ a: 1 })).toBe('{"a":1}');
  });

  it("round-trips through JSON.parse", () => {
    const obj = { hello: "world", n: 42 };
    expect(JSON.parse(jsonStringify(obj))).toEqual(obj);
  });
});

describe("parseJSONL", () => {
  it("parses valid JSONL", () => {
    const input = '{"a":1}\n{"b":2}\n';
    expect(parseJSONL(input)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips empty lines", () => {
    const input = '{"a":1}\n\n\n{"b":2}\n';
    expect(parseJSONL(input)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips malformed lines", () => {
    const input = '{"a":1}\nnot json\n{"b":2}\n';
    expect(parseJSONL(input)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("returns empty array for empty input", () => {
    expect(parseJSONL("")).toEqual([]);
    expect(parseJSONL("\n\n")).toEqual([]);
  });
});

describe("generateUUID", () => {
  it("returns a string matching UUID v4 format", () => {
    const uuid = generateUUID();
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("returns unique values", () => {
    const a = generateUUID();
    const b = generateUUID();
    expect(a).not.toBe(b);
  });
});
