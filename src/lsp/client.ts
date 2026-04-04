import { spawn, type ChildProcess } from "node:child_process";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
  type RequestType,
} from "vscode-jsonrpc/node.js";
import type { LspServerConfig, LspServerState, LspDiagnostic } from "./types.js";

interface ServerCapabilities {
  definitionProvider?: boolean;
  referencesProvider?: boolean;
  hoverProvider?: boolean;
  documentSymbolProvider?: boolean;
  workspaceSymbolProvider?: boolean;
  [key: string]: unknown;
}

/**
 * Wraps a single LSP server process with JSON-RPC communication.
 */
export class LspClient {
  private process: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private config: LspServerConfig;
  private _state: LspServerState = "stopped";
  private capabilities: ServerCapabilities = {};
  private diagnosticHandler?: (diagnostics: LspDiagnostic[]) => void;

  constructor(config: LspServerConfig) {
    this.config = config;
  }

  get state(): LspServerState {
    return this._state;
  }

  onDiagnostics(handler: (diagnostics: LspDiagnostic[]) => void): void {
    this.diagnosticHandler = handler;
  }

  async start(rootUri: string): Promise<void> {
    if (this._state === "running") return;
    this._state = "starting";

    try {
      this.process = spawn(this.config.command, this.config.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.config.env },
      });

      if (!this.process.stdout || !this.process.stdin) {
        throw new Error("Failed to get stdio streams from LSP server");
      }

      this.connection = createMessageConnection(
        new StreamMessageReader(this.process.stdout),
        new StreamMessageWriter(this.process.stdin),
      );

      this.connection.onNotification(
        "textDocument/publishDiagnostics",
        (params: { uri: string; diagnostics: Array<{ range: { start: { line: number; character: number } }; severity?: number; message: string; source?: string }> }) => {
          if (!this.diagnosticHandler) return;
          const filePath = params.uri.startsWith("file://")
            ? params.uri.slice(7)
            : params.uri;
          const mapped = params.diagnostics.map((d) => ({
            filePath,
            line: d.range.start.line + 1,
            character: d.range.start.character + 1,
            severity: mapSeverity(d.severity),
            message: d.message,
            source: d.source,
          }));
          this.diagnosticHandler(mapped);
        },
      );

      this.connection.listen();

      const initResult = await this.connection.sendRequest(
        "initialize" as unknown as RequestType<unknown, unknown, unknown>,
        {
          processId: process.pid,
          capabilities: {
            textDocument: {
              synchronization: { didSave: true },
              publishDiagnostics: {},
              hover: { contentFormat: ["plaintext"] },
              definition: { linkSupport: true },
              references: {},
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            },
          },
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: "workspace" }],
        },
      );

      this.capabilities =
        (initResult as { capabilities?: ServerCapabilities })?.capabilities ?? {};

      this.connection.sendNotification("initialized", {});
      this._state = "running";

      this.process.on("exit", () => {
        this._state = "stopped";
        this.connection = null;
        this.process = null;
      });
    } catch (err) {
      this._state = "error";
      this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.connection) {
      try {
        await this.connection.sendRequest(
          "shutdown" as unknown as RequestType<unknown, unknown, unknown>,
          null,
        );
        this.connection.sendNotification("exit");
      } catch {
        // ignore errors during shutdown
      }
      this.connection.dispose();
      this.connection = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this._state = "stopped";
  }

  async sendRequest<T>(method: string, params: unknown): Promise<T> {
    if (!this.connection || this._state !== "running") {
      throw new Error(`LSP server not running (state: ${this._state})`);
    }
    return this.connection.sendRequest(
      method as unknown as RequestType<unknown, T, unknown>,
      params,
    ) as Promise<T>;
  }

  sendNotification(method: string, params: unknown): void {
    if (!this.connection || this._state !== "running") return;
    this.connection.sendNotification(method, params);
  }

  hasCapability(name: keyof ServerCapabilities): boolean {
    return !!this.capabilities[name];
  }
}

function mapSeverity(
  severity: number | undefined,
): "error" | "warning" | "info" | "hint" {
  switch (severity) {
    case 1: return "error";
    case 2: return "warning";
    case 3: return "info";
    case 4: return "hint";
    default: return "info";
  }
}
