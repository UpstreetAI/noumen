import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { ACP_METHODS, type AcpTransport } from "../acp/types.js";
import { StdioTransport } from "../acp/transport-stdio.js";
import {
  formatResponse,
  formatError,
  formatNotification,
  formatRequest,
  isRequest,
  isNotification,
  isResponse,
  parseMessage,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
} from "../jsonrpc/index.js";

function createMockTransport(): AcpTransport & {
  sentMessages: unknown[];
  messageHandler: ((msg: unknown) => void) | null;
  closeHandler: (() => void) | null;
} {
  const transport = {
    sentMessages: [] as unknown[],
    messageHandler: null as ((msg: unknown) => void) | null,
    closeHandler: null as (() => void) | null,
    send(msg: unknown) {
      transport.sentMessages.push(msg);
    },
    onMessage(handler: (msg: unknown) => void) {
      transport.messageHandler = handler;
    },
    onClose(handler: () => void) {
      transport.closeHandler = handler;
    },
    close() {
      transport.closeHandler?.();
    },
  };
  return transport;
}

// ---------------------------------------------------------------------------
// ACP_METHODS constants
// ---------------------------------------------------------------------------

describe("ACP types", () => {
  it("defines all required method constants", () => {
    expect(ACP_METHODS.INITIALIZE).toBe("initialize");
    expect(ACP_METHODS.SESSION_NEW).toBe("session/new");
    expect(ACP_METHODS.SESSION_PROMPT).toBe("session/prompt");
    expect(ACP_METHODS.SESSION_LOAD).toBe("session/load");
    expect(ACP_METHODS.SESSION_ABORT).toBe("session/abort");
    expect(ACP_METHODS.FS_READ).toBe("fs/read_text_file");
    expect(ACP_METHODS.FS_WRITE).toBe("fs/write_text_file");
    expect(ACP_METHODS.TERMINAL_EXEC).toBe("terminal/exec");
    expect(ACP_METHODS.STREAM_TEXT).toBe("stream/text");
    expect(ACP_METHODS.STREAM_COMPLETE).toBe("stream/complete");
    expect(ACP_METHODS.PERMISSION_REQUEST).toBe("permission/request");
  });

  it("defines all stream notification methods", () => {
    expect(ACP_METHODS.STREAM_THINKING).toBe("stream/thinking");
    expect(ACP_METHODS.STREAM_TOOL_USE).toBe("stream/toolUse");
    expect(ACP_METHODS.STREAM_TOOL_RESULT).toBe("stream/toolResult");
    expect(ACP_METHODS.STREAM_ERROR).toBe("stream/error");
  });

  it("defines user input methods", () => {
    expect(ACP_METHODS.USER_INPUT_REQUEST).toBe("userInput/request");
    expect(ACP_METHODS.USER_INPUT_RESPONSE).toBe("userInput/response");
  });

  it("defines all fs methods", () => {
    expect(ACP_METHODS.FS_READ_BYTES).toBe("fs/read_bytes");
    expect(ACP_METHODS.FS_STAT).toBe("fs/stat");
    expect(ACP_METHODS.FS_EXISTS).toBe("fs/exists");
    expect(ACP_METHODS.FS_READDIR).toBe("fs/readdir");
    expect(ACP_METHODS.FS_MKDIR).toBe("fs/mkdir");
    expect(ACP_METHODS.FS_DELETE).toBe("fs/delete");
  });
});

// ---------------------------------------------------------------------------
// AcpTransport mock
// ---------------------------------------------------------------------------

describe("AcpTransport interface", () => {
  it("mock transport sends and receives messages", () => {
    const transport = createMockTransport();
    transport.onMessage((msg) => {
      expect(msg).toEqual({ test: true });
    });

    transport.send({ hello: "world" });
    expect(transport.sentMessages).toHaveLength(1);

    transport.messageHandler!({ test: true });
  });

  it("mock transport fires close handler", () => {
    const transport = createMockTransport();
    const closeFn = vi.fn();
    transport.onClose(closeFn);
    transport.close();
    expect(closeFn).toHaveBeenCalledOnce();
  });

  it("mock transport accumulates multiple sent messages", () => {
    const transport = createMockTransport();
    transport.send({ a: 1 });
    transport.send({ b: 2 });
    transport.send({ c: 3 });
    expect(transport.sentMessages).toHaveLength(3);
  });

  it("transport can set message handler before sending", () => {
    const transport = createMockTransport();
    const received: unknown[] = [];
    transport.onMessage((msg) => received.push(msg));
    transport.messageHandler!({ x: 1 });
    transport.messageHandler!({ y: 2 });
    expect(received).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// StdioTransport — NDJSON framing
// ---------------------------------------------------------------------------

describe("StdioTransport", () => {
  function createMockStreams() {
    const input = new EventEmitter() as EventEmitter & { setEncoding?: (enc: string) => void };
    input.setEncoding = vi.fn();
    const outputChunks: string[] = [];
    const output = {
      write: vi.fn((data: string) => { outputChunks.push(data); return true; }),
    };
    return { input, output: output as unknown as NodeJS.WritableStream, outputChunks };
  }

  it("parses valid NDJSON lines into messages", async () => {
    const { input, output } = createMockStreams();
    const transport = new StdioTransport(input as unknown as NodeJS.ReadableStream, output);
    const received: unknown[] = [];
    transport.onMessage((msg) => received.push(msg));

    input.emit("data", '{"jsonrpc":"2.0","method":"test"}\n');
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ jsonrpc: "2.0", method: "test" });
  });

  it("handles partial lines (buffering)", async () => {
    const { input, output } = createMockStreams();
    const transport = new StdioTransport(input as unknown as NodeJS.ReadableStream, output);
    const received: unknown[] = [];
    transport.onMessage((msg) => received.push(msg));

    input.emit("data", '{"jsonrpc":"2');
    expect(received).toHaveLength(0);

    input.emit("data", '.0","method":"test"}\n');
    expect(received).toHaveLength(1);
  });

  it("handles multiple lines in one chunk", async () => {
    const { input, output } = createMockStreams();
    const transport = new StdioTransport(input as unknown as NodeJS.ReadableStream, output);
    const received: unknown[] = [];
    transport.onMessage((msg) => received.push(msg));

    input.emit("data", '{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(received).toHaveLength(3);
  });

  it("skips malformed JSON lines", async () => {
    const { input, output } = createMockStreams();
    const transport = new StdioTransport(input as unknown as NodeJS.ReadableStream, output);
    const received: unknown[] = [];
    transport.onMessage((msg) => received.push(msg));

    input.emit("data", 'not json\n{"valid":true}\n');
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ valid: true });
  });

  it("skips empty lines", async () => {
    const { input, output } = createMockStreams();
    const transport = new StdioTransport(input as unknown as NodeJS.ReadableStream, output);
    const received: unknown[] = [];
    transport.onMessage((msg) => received.push(msg));

    input.emit("data", '\n\n{"ok":true}\n\n');
    expect(received).toHaveLength(1);
  });

  it("sends messages as NDJSON", () => {
    const { input, output, outputChunks } = createMockStreams();
    const transport = new StdioTransport(input as unknown as NodeJS.ReadableStream, output);

    transport.send({ method: "test", params: {} });
    expect(outputChunks).toHaveLength(1);
    expect(outputChunks[0]).toContain('"method":"test"');
    expect(outputChunks[0].endsWith("\n")).toBe(true);
  });

  it("does not send after close", () => {
    const { input, output, outputChunks } = createMockStreams();
    const transport = new StdioTransport(input as unknown as NodeJS.ReadableStream, output);

    transport.close();
    transport.send({ method: "test" });
    expect(outputChunks).toHaveLength(0);
  });

  it("fires close handler on end", () => {
    const { input, output } = createMockStreams();
    const transport = new StdioTransport(input as unknown as NodeJS.ReadableStream, output);
    const closeFn = vi.fn();
    transport.onClose(closeFn);
    input.emit("end");
    expect(closeFn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

describe("JSON-RPC helpers", () => {
  it("formatResponse produces correct structure", () => {
    const resp = formatResponse(1, { ok: true });
    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe(1);
    expect(resp.result).toEqual({ ok: true });
  });

  it("formatError produces correct structure", () => {
    const err = formatError(2, INTERNAL_ERROR, "bad");
    expect(err.jsonrpc).toBe("2.0");
    expect(err.id).toBe(2);
    expect(err.error.code).toBe(INTERNAL_ERROR);
    expect(err.error.message).toBe("bad");
  });

  it("formatError includes data when provided", () => {
    const err = formatError(3, PARSE_ERROR, "parse fail", { detail: "x" });
    expect(err.error.data).toEqual({ detail: "x" });
  });

  it("formatNotification produces correct structure", () => {
    const notif = formatNotification("stream/text", { text: "hi" });
    expect(notif.jsonrpc).toBe("2.0");
    expect(notif.method).toBe("stream/text");
    expect(notif.params).toEqual({ text: "hi" });
    expect("id" in notif).toBe(false);
  });

  it("formatRequest produces correct structure", () => {
    const req = formatRequest(10, "fs/read", { path: "/a" });
    expect(req.jsonrpc).toBe("2.0");
    expect(req.id).toBe(10);
    expect(req.method).toBe("fs/read");
    expect(req.params).toEqual({ path: "/a" });
  });

  it("isRequest identifies requests", () => {
    expect(isRequest({ jsonrpc: "2.0", id: 1, method: "test" })).toBe(true);
    expect(isRequest({ jsonrpc: "2.0", method: "test" })).toBe(false);
    expect(isRequest({ jsonrpc: "2.0", id: 1, result: {} })).toBe(false);
  });

  it("isNotification identifies notifications", () => {
    expect(isNotification({ jsonrpc: "2.0", method: "test" })).toBe(true);
    expect(isNotification({ jsonrpc: "2.0", id: 1, method: "test" })).toBe(false);
  });

  it("isResponse identifies responses", () => {
    expect(isResponse({ jsonrpc: "2.0", id: 1, result: {} })).toBe(true);
    expect(isResponse({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "fail" } })).toBe(true);
    expect(isResponse({ jsonrpc: "2.0", id: 1, method: "test" })).toBe(false);
  });

  it("parseMessage parses valid JSON-RPC", () => {
    const msg = parseMessage('{"jsonrpc":"2.0","id":1,"method":"test"}');
    expect(msg).toEqual({ jsonrpc: "2.0", id: 1, method: "test" });
  });

  it("parseMessage throws on invalid JSON", () => {
    expect(() => parseMessage("not json")).toThrow();
  });

  it("parseMessage throws on non-object JSON", () => {
    expect(() => parseMessage('"string"')).toThrow("must be an object");
  });

  it("error codes have correct values", () => {
    expect(PARSE_ERROR).toBe(-32700);
    expect(INVALID_REQUEST).toBe(-32600);
    expect(METHOD_NOT_FOUND).toBe(-32601);
    expect(INVALID_PARAMS).toBe(-32602);
    expect(INTERNAL_ERROR).toBe(-32603);
  });
});
