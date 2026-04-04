import { describe, it, expect, vi } from "vitest";
import { ACP_METHODS, type AcpTransport } from "../acp/types.js";

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
});

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
});
