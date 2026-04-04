import { describe, it, expect } from "vitest";
import {
  formatResponse,
  formatError,
  formatNotification,
  formatRequest,
  parseMessage,
  isRequest,
  isNotification,
  isResponse,
  JSONRPC_VERSION,
  PARSE_ERROR,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
} from "../jsonrpc/index.js";

describe("JSON-RPC helpers", () => {
  describe("formatResponse", () => {
    it("creates a valid success response", () => {
      const res = formatResponse(1, { data: "hello" });
      expect(res.jsonrpc).toBe("2.0");
      expect(res.id).toBe(1);
      expect(res.result).toEqual({ data: "hello" });
    });
  });

  describe("formatError", () => {
    it("creates an error response with code and message", () => {
      const res = formatError(2, INTERNAL_ERROR, "something broke");
      expect(res.jsonrpc).toBe("2.0");
      expect(res.id).toBe(2);
      expect(res.error.code).toBe(-32603);
      expect(res.error.message).toBe("something broke");
    });

    it("includes optional data", () => {
      const res = formatError(3, INVALID_PARAMS, "bad", { field: "x" });
      expect(res.error.data).toEqual({ field: "x" });
    });
  });

  describe("formatNotification", () => {
    it("creates a notification without id", () => {
      const notif = formatNotification("stream/text", { text: "hi" });
      expect(notif.jsonrpc).toBe("2.0");
      expect(notif.method).toBe("stream/text");
      expect(notif.params).toEqual({ text: "hi" });
      expect("id" in notif).toBe(false);
    });
  });

  describe("formatRequest", () => {
    it("creates a request with id and method", () => {
      const req = formatRequest(10, "fs/read_text_file", { path: "/a" });
      expect(req.jsonrpc).toBe("2.0");
      expect(req.id).toBe(10);
      expect(req.method).toBe("fs/read_text_file");
      expect(req.params).toEqual({ path: "/a" });
    });
  });

  describe("parseMessage", () => {
    it("parses valid JSON-RPC", () => {
      const raw = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "init" });
      const msg = parseMessage(raw);
      expect(isRequest(msg)).toBe(true);
    });

    it("throws on invalid JSON", () => {
      expect(() => parseMessage("not json")).toThrow();
    });
  });

  describe("type guards", () => {
    it("isRequest identifies requests", () => {
      expect(isRequest({ jsonrpc: "2.0", id: 1, method: "test" })).toBe(true);
      expect(isRequest({ jsonrpc: "2.0", method: "test" })).toBe(false);
    });

    it("isNotification identifies notifications", () => {
      expect(isNotification({ jsonrpc: "2.0", method: "test" })).toBe(true);
      expect(isNotification({ jsonrpc: "2.0", id: 1, method: "test" })).toBe(false);
    });

    it("isResponse identifies responses", () => {
      expect(isResponse({ jsonrpc: "2.0", id: 1, result: {} })).toBe(true);
      expect(isResponse({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "err" } })).toBe(true);
      expect(isResponse({ jsonrpc: "2.0", method: "x" })).toBe(false);
    });
  });

  describe("error codes", () => {
    it("has standard JSON-RPC error codes", () => {
      expect(PARSE_ERROR).toBe(-32700);
      expect(METHOD_NOT_FOUND).toBe(-32601);
      expect(INVALID_PARAMS).toBe(-32602);
      expect(INTERNAL_ERROR).toBe(-32603);
    });
  });
});
