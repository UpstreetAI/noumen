/**
 * Minimal JSON-RPC 2.0 types and helpers shared by ACP and A2A adapters.
 *
 * Spec: https://www.jsonrpc.org/specification
 */

export const JSONRPC_VERSION = "2.0" as const;

// ── Types ───────────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number | null;
  error: JsonRpcErrorObject;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

// ── Standard error codes ────────────────────────────────────────────────────

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// ── Helpers ─────────────────────────────────────────────────────────────────

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg;
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "result" in msg || "error" in msg;
}

export function formatResponse(
  id: string | number,
  result: unknown,
): JsonRpcSuccessResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function formatError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

export function formatNotification(
  method: string,
  params?: unknown,
): JsonRpcNotification {
  return { jsonrpc: JSONRPC_VERSION, method, ...(params !== undefined ? { params } : {}) };
}

export function formatRequest(
  id: string | number,
  method: string,
  params?: unknown,
): JsonRpcRequest {
  return { jsonrpc: JSONRPC_VERSION, id, method, ...(params !== undefined ? { params } : {}) };
}

/**
 * Parse a raw string into a JSON-RPC message. Throws on invalid JSON.
 * Does NOT validate against the full JSON-RPC schema — callers should
 * check `isRequest` / `isNotification` / `isResponse` after parsing.
 */
export function parseMessage(raw: string): JsonRpcMessage {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("JSON-RPC message must be an object");
  }
  return parsed as JsonRpcMessage;
}
