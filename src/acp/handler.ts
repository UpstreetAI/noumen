/**
 * ACP protocol handler: maps ACP JSON-RPC methods to Code/Thread APIs.
 */

import type { Code } from "../code.js";
import type { Thread } from "../thread.js";
import type { StreamEvent } from "../session/types.js";
import type { PermissionRequest, PermissionResponse } from "../permissions/types.js";
import type {
  AcpTransport,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpSessionNewParams,
  AcpSessionPromptParams,
  AcpSessionLoadParams,
} from "./types.js";
import { ACP_METHODS } from "./types.js";
import {
  formatResponse,
  formatError,
  formatNotification,
  isRequest,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "../jsonrpc/index.js";
import { contentToString } from "../utils/content.js";

export interface AcpHandlerOptions {
  agentName?: string;
  agentVersion?: string;
}

interface SessionState {
  thread: Thread;
  running: boolean;
  abortController: AbortController | null;
  pendingPermission: {
    resolve: (response: PermissionResponse) => void;
  } | null;
  pendingInput: {
    resolve: (answer: string) => void;
  } | null;
}

export class AcpHandler {
  private code: Code;
  private transport: AcpTransport;
  private options: AcpHandlerOptions;
  private sessions = new Map<string, SessionState>();
  private initialized = false;
  private clientCapabilities: { filesystem?: boolean; terminal?: boolean } = {};
  private pendingRequests = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private nextRequestId = 1;

  constructor(
    code: Code,
    transport: AcpTransport,
    options?: AcpHandlerOptions,
  ) {
    this.code = code;
    this.transport = transport;
    this.options = options ?? {};

    transport.onMessage((msg) => this.handleMessage(msg as JsonRpcMessage));
    transport.onClose(() => this.handleClose());
  }

  /**
   * Send a JSON-RPC request to the client and wait for the response.
   * Used by AcpClientSandbox to invoke client-side fs/terminal methods.
   */
  async sendClientRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.transport.send({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    });
  }

  private async handleMessage(msg: JsonRpcMessage): Promise<void> {
    // Handle responses to our client requests
    if ("result" in msg || "error" in msg) {
      const response = msg as { id: string | number; result?: unknown; error?: { message: string } };
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if ("error" in response && response.error) {
          pending.reject(new Error(response.error.message));
        } else {
          pending.resolve(response.result);
        }
      }
      return;
    }

    if (!isRequest(msg)) return;

    const request = msg as JsonRpcRequest;
    try {
      const result = await this.dispatch(request);
      if (result !== undefined) {
        this.transport.send(formatResponse(request.id, result));
      }
    } catch (err) {
      this.transport.send(
        formatError(
          request.id,
          INTERNAL_ERROR,
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      case ACP_METHODS.INITIALIZE:
        return this.handleInitialize(request.params as AcpInitializeParams);

      case ACP_METHODS.SESSION_NEW:
        return this.handleSessionNew(request.params as AcpSessionNewParams);

      case ACP_METHODS.SESSION_PROMPT:
        this.handleSessionPrompt(
          request.id,
          request.params as AcpSessionPromptParams,
        );
        return undefined;

      case ACP_METHODS.SESSION_LOAD:
        return this.handleSessionLoad(request.params as AcpSessionLoadParams);

      case ACP_METHODS.SESSION_ABORT: {
        const p = request.params as { sessionId: string };
        const session = this.sessions.get(p.sessionId);
        if (session) {
          session.abortController?.abort();
        }
        return { ok: true };
      }

      case ACP_METHODS.PERMISSION_RESPONSE: {
        const p = request.params as { sessionId: string; allow: boolean; feedback?: string };
        const session = this.sessions.get(p.sessionId);
        if (session?.pendingPermission) {
          session.pendingPermission.resolve({
            allow: p.allow,
            feedback: p.feedback,
          });
          session.pendingPermission = null;
        }
        return { ok: true };
      }

      case ACP_METHODS.USER_INPUT_RESPONSE: {
        const p = request.params as { sessionId: string; answer: string };
        const session = this.sessions.get(p.sessionId);
        if (session?.pendingInput) {
          session.pendingInput.resolve(p.answer ?? "");
          session.pendingInput = null;
        }
        return { ok: true };
      }

      default:
        throw Object.assign(
          new Error(`Unknown method: ${request.method}`),
          { code: METHOD_NOT_FOUND },
        );
    }
  }

  private handleInitialize(
    params: AcpInitializeParams,
  ): AcpInitializeResult {
    this.initialized = true;
    this.clientCapabilities = params.capabilities ?? {};

    return {
      agentName: this.options.agentName ?? "noumen",
      agentVersion: this.options.agentVersion ?? "0.1.0",
      protocolVersion: "0.1.0",
      capabilities: {
        streaming: true,
        permissions: true,
        sessions: true,
      },
    };
  }

  private handleSessionNew(
    params: AcpSessionNewParams,
  ): { sessionId: string } {
    const thread = this.code.createThread({
      sessionId: params.sessionId,
      permissionHandler: (req: PermissionRequest) =>
        this.bridgePermission(thread.sessionId, req),
      userInputHandler: (question: string) =>
        this.bridgeUserInput(thread.sessionId, question),
    });

    this.sessions.set(thread.sessionId, {
      thread,
      running: false,
      abortController: null,
      pendingPermission: null,
      pendingInput: null,
    });

    return { sessionId: thread.sessionId };
  }

  private async handleSessionPrompt(
    requestId: string | number,
    params: AcpSessionPromptParams,
  ): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      this.transport.send(
        formatError(requestId, INVALID_PARAMS, `Session not found: ${params.sessionId}`),
      );
      return;
    }

    session.running = true;
    session.abortController = new AbortController();

    // Acknowledge the prompt request immediately
    this.transport.send(formatResponse(requestId, { ok: true }));

    try {
      for await (const event of session.thread.run(params.prompt, {
        signal: session.abortController.signal,
      })) {
        this.emitStreamEvent(params.sessionId, event);
      }
    } catch (err) {
      this.transport.send(
        formatNotification(ACP_METHODS.STREAM_ERROR, {
          sessionId: params.sessionId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      session.running = false;
      session.abortController = null;
    }
  }

  private handleSessionLoad(
    params: AcpSessionLoadParams,
  ): { sessionId: string } {
    const thread = this.code.resumeThread(params.sessionId, {
      permissionHandler: (req: PermissionRequest) =>
        this.bridgePermission(params.sessionId, req),
      userInputHandler: (question: string) =>
        this.bridgeUserInput(params.sessionId, question),
    });

    this.sessions.set(params.sessionId, {
      thread,
      running: false,
      abortController: null,
      pendingPermission: null,
      pendingInput: null,
    });

    return { sessionId: params.sessionId };
  }

  private emitStreamEvent(sessionId: string, event: StreamEvent): void {
    switch (event.type) {
      case "text_delta":
        this.transport.send(
          formatNotification(ACP_METHODS.STREAM_TEXT, {
            sessionId,
            text: event.text,
          }),
        );
        break;

      case "thinking_delta":
        this.transport.send(
          formatNotification(ACP_METHODS.STREAM_THINKING, {
            sessionId,
            text: event.text,
          }),
        );
        break;

      case "tool_use_start":
        this.transport.send(
          formatNotification(ACP_METHODS.STREAM_TOOL_USE, {
            sessionId,
            toolName: event.toolName,
            toolUseId: event.toolUseId,
            phase: "start",
          }),
        );
        break;

      case "tool_result":
        this.transport.send(
          formatNotification(ACP_METHODS.STREAM_TOOL_RESULT, {
            sessionId,
            toolName: event.toolName,
            toolUseId: event.toolUseId,
            result: contentToString(event.result.content),
            isError: event.result.isError,
          }),
        );
        break;

      case "message_complete":
        this.transport.send(
          formatNotification(ACP_METHODS.STREAM_COMPLETE, {
            sessionId,
            text: event.message.content,
          }),
        );
        break;

      case "turn_complete":
        this.transport.send(
          formatNotification(ACP_METHODS.STREAM_COMPLETE, {
            sessionId,
            done: true,
            usage: event.usage,
          }),
        );
        break;

      case "error":
        this.transport.send(
          formatNotification(ACP_METHODS.STREAM_ERROR, {
            sessionId,
            error: event.error.message,
          }),
        );
        break;

      case "permission_request":
        this.transport.send(
          formatNotification(ACP_METHODS.PERMISSION_REQUEST, {
            sessionId,
            toolName: event.toolName,
            input: event.input,
            message: event.message,
          }),
        );
        break;

      case "user_input_request":
        this.transport.send(
          formatNotification(ACP_METHODS.USER_INPUT_REQUEST, {
            sessionId,
            toolUseId: event.toolUseId,
            question: event.question,
          }),
        );
        break;
    }
  }

  private bridgePermission(
    sessionId: string,
    request: PermissionRequest,
  ): Promise<PermissionResponse> {
    return new Promise<PermissionResponse>((resolve) => {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.pendingPermission = { resolve };
      }
    });
  }

  private bridgeUserInput(
    sessionId: string,
    question: string,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.pendingInput = { resolve };
      }
    });
  }

  private handleClose(): void {
    for (const session of this.sessions.values()) {
      session.abortController?.abort();
    }
    this.sessions.clear();
  }
}
