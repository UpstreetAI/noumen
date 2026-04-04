import type { VirtualFs } from "../virtual/fs.js";
import type { VirtualComputer } from "../virtual/computer.js";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolContext {
  fs: VirtualFs;
  computer: VirtualComputer;
  cwd: string;
}

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameters;
  /** Present on tools sourced from an MCP server */
  mcpInfo?: { serverName: string; toolName: string };
  call(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
