/**
 * A2A (Agent2Agent) protocol adapter for noumen.
 *
 * Server usage:
 *   import { createA2AServer } from "noumen/a2a";
 *   const server = createA2AServer(code, { name: "MyAgent", url: "https://..." });
 *   await server.start();
 *
 * Client usage:
 *   import { A2AClient } from "noumen/a2a";
 *   const client = new A2AClient("https://remote-agent.example.com");
 *   const card = await client.getAgentCard();
 *   const task = await client.ask("Fix the bug in auth.ts");
 */

export { A2AServer, type A2AServerOptions } from "./server.js";
export { A2AClient, type A2AClientOptions } from "./client.js";
export { TaskManager } from "./task-manager.js";
export { buildAgentCard, type AgentCardOptions } from "./agent-card.js";
export {
  type AgentCard,
  type AgentSkill,
  type Task,
  type TaskState,
  type TaskStatus,
  type Message,
  type Part,
  type TextPart,
  type FilePart,
  type DataPart,
  type Artifact,
  type TaskSendParams,
  type TaskStreamEvent,
  A2A_METHODS,
} from "./types.js";

import type { Agent } from "../agent.js";
import { A2AServer, type A2AServerOptions } from "./server.js";

/**
 * Create an A2A server that exposes an Agent instance via the Agent2Agent protocol.
 */
export function createA2AServer(
  code: Agent,
  options: A2AServerOptions,
): A2AServer {
  return new A2AServer(code, options);
}
