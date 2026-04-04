/**
 * A2A HTTP server implementing the Agent2Agent protocol endpoints.
 *
 * Endpoints:
 *   GET  /.well-known/agent.json  ->  Agent Card
 *   POST /                        ->  JSON-RPC dispatch
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Code } from "../code.js";
import type { AgentCard } from "./types.js";
import { A2A_METHODS, type TaskSendParams, type TaskStreamEvent } from "./types.js";
import { TaskManager } from "./task-manager.js";
import { buildAgentCard, type AgentCardOptions } from "./agent-card.js";
import {
  formatResponse,
  formatError,
  parseMessage,
  isRequest,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  PARSE_ERROR,
  type JsonRpcRequest,
} from "../jsonrpc/index.js";

export interface A2AServerOptions extends AgentCardOptions {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** CORS origin header (default: "*") */
  cors?: string | false;
}

export class A2AServer {
  private httpServer: ReturnType<typeof createServer> | null = null;
  private taskManager: TaskManager;
  private agentCard: AgentCard;
  private options: A2AServerOptions;

  constructor(code: Code, options: A2AServerOptions) {
    this.taskManager = new TaskManager(code);
    this.agentCard = buildAgentCard(options);
    this.options = options;
  }

  async start(): Promise<void> {
    const port = this.options.port ?? 3000;

    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
    });

    return new Promise<void>((resolve) => {
      this.httpServer!.listen(port, () => resolve());
    });
  }

  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // CORS
    if (this.options.cors !== false) {
      res.setHeader("Access-Control-Allow-Origin", this.options.cors ?? "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Agent Card discovery
    if (url.pathname === "/.well-known/agent.json" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.agentCard));
      return;
    }

    // JSON-RPC endpoint
    if (url.pathname === "/" && req.method === "POST") {
      const body = await readBody(req);
      let msg;
      try {
        msg = parseMessage(body);
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(formatError(null, PARSE_ERROR, "Invalid JSON")));
        return;
      }

      if (!isRequest(msg)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(formatError(null, PARSE_ERROR, "Expected JSON-RPC request")));
        return;
      }

      const request = msg as JsonRpcRequest;

      // Check if this is a streaming request
      if (request.method === A2A_METHODS.TASKS_SEND_SUBSCRIBE) {
        await this.handleStreamingRequest(request, res);
        return;
      }

      try {
        const result = await this.dispatch(request);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(formatResponse(request.id, result)));
      } catch (err) {
        const code = (err as { code?: number }).code ?? INTERNAL_ERROR;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            formatError(
              request.id,
              code,
              err instanceof Error ? err.message : String(err),
            ),
          ),
        );
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      case A2A_METHODS.TASKS_SEND: {
        const params = request.params as TaskSendParams;
        if (!params?.message) {
          throw Object.assign(new Error("Missing message"), {
            code: INVALID_PARAMS,
          });
        }
        return this.taskManager.sendTask(params);
      }

      case A2A_METHODS.TASKS_GET: {
        const params = request.params as { id: string };
        const task = this.taskManager.getTask(params.id);
        if (!task) {
          throw Object.assign(new Error(`Task not found: ${params.id}`), {
            code: INVALID_PARAMS,
          });
        }
        return task;
      }

      case A2A_METHODS.TASKS_CANCEL: {
        const params = request.params as { id: string };
        const canceled = this.taskManager.cancelTask(params.id);
        if (!canceled) {
          throw Object.assign(new Error(`Task not found: ${params.id}`), {
            code: INVALID_PARAMS,
          });
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

  private async handleStreamingRequest(
    request: JsonRpcRequest,
    res: ServerResponse,
  ): Promise<void> {
    const params = request.params as TaskSendParams;
    if (!params?.message) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          formatError(request.id, INVALID_PARAMS, "Missing message"),
        ),
      );
      return;
    }

    // SSE response
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      for await (const event of this.taskManager.sendTaskSubscribe(params)) {
        const data = JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: event,
        });
        res.write(`data: ${data}\n\n`);
      }
    } catch (err) {
      const errorData = JSON.stringify(
        formatError(
          request.id,
          INTERNAL_ERROR,
          err instanceof Error ? err.message : String(err),
        ),
      );
      res.write(`data: ${errorData}\n\n`);
    }

    res.end();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
