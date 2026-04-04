/**
 * ACP (Agent Client Protocol) adapter for noumen.
 *
 * Usage:
 *   import { createAcpServer, StdioTransport, AcpClientSandbox } from "noumen/acp";
 *
 *   // Stdio mode (editor launches agent as subprocess)
 *   const transport = new StdioTransport();
 *   const handler = createAcpServer(code, transport);
 *
 *   // Or use AcpClientSandbox to let the client provide fs/terminal
 *   const sandbox = new AcpClientSandbox(transport, handler.sendClientRequest);
 *   const agent = new Agent({ provider, sandbox });
 */

export { AcpHandler, type AcpHandlerOptions } from "./handler.js";
export { StdioTransport } from "./transport-stdio.js";
export { AcpClientSandbox } from "./client-sandbox.js";
export {
  type AcpTransport,
  type AcpCapabilities,
  type AcpInitializeParams,
  type AcpInitializeResult,
  type AcpSessionNewParams,
  type AcpSessionPromptParams,
  ACP_METHODS,
} from "./types.js";

import type { Agent } from "../agent.js";
import type { AcpTransport } from "./types.js";
import { AcpHandler, type AcpHandlerOptions } from "./handler.js";

/**
 * Create an ACP server that bridges an ACP transport to an Agent instance.
 */
export function createAcpServer(
  code: Agent,
  transport: AcpTransport,
  options?: AcpHandlerOptions,
): AcpHandler {
  return new AcpHandler(code, transport, options);
}
