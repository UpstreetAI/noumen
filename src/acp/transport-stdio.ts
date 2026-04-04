/**
 * ACP stdio transport: newline-delimited JSON-RPC over stdin/stdout.
 */

import type { AcpTransport } from "./types.js";

export class StdioTransport implements AcpTransport {
  private messageHandler: ((message: unknown) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private buffer = "";
  private closed = false;

  constructor(
    private input: NodeJS.ReadableStream = process.stdin,
    private output: NodeJS.WritableStream = process.stdout,
  ) {
    this.input.setEncoding?.("utf-8");
    this.input.on("data", (chunk: string) => this.onData(chunk));
    this.input.on("end", () => this.handleClose());
    this.input.on("error", () => this.handleClose());
  }

  send(message: unknown): void {
    if (this.closed) return;
    const line = JSON.stringify(message) + "\n";
    this.output.write(line);
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handleClose();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        this.messageHandler?.(msg);
      } catch {
        // Skip malformed lines (per ACP spec: agents may write to stderr for logs)
      }
    }
  }

  private handleClose(): void {
    this.closed = true;
    this.closeHandler?.();
  }
}
