/**
 * Build an A2A Agent Card from a noumen Code instance configuration.
 */

import type { AgentCard, AgentSkill } from "./types.js";

export interface AgentCardOptions {
  name: string;
  description?: string;
  url: string;
  version?: string;
  provider?: {
    organization: string;
    url?: string;
  };
  skills?: AgentSkill[];
  authentication?: {
    schemes: string[];
    credentials?: string;
  };
  streaming?: boolean;
}

export function buildAgentCard(options: AgentCardOptions): AgentCard {
  return {
    name: options.name,
    description: options.description ?? "A noumen-powered AI coding agent",
    url: options.url,
    version: options.version ?? "0.1.0",
    provider: options.provider,
    capabilities: {
      streaming: options.streaming ?? true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    authentication: options.authentication,
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: options.skills ?? [
      {
        id: "coding",
        name: "Code Generation & Editing",
        description: "Read, write, and edit code files with full tool access",
        tags: ["coding", "files", "shell"],
      },
    ],
  };
}
