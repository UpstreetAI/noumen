import type { StreamEvent } from "../session/types.js";
import type { PermissionHandler } from "../permissions/types.js";

export type SwarmMemberStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "killed";

export interface SwarmMemberConfig {
  name: string;
  prompt: string;
  systemPrompt?: string;
  allowedTools?: string[];
  model?: string;
}

export interface SwarmMember {
  id: string;
  name: string;
  status: SwarmMemberStatus;
  sessionId?: string;
  result?: string;
  error?: Error;
}

export interface SwarmMessage {
  from: string;
  to: string;
  content: string;
  timestamp: string;
}

export interface SwarmConfig {
  /** Maximum number of concurrent members (default: 4). */
  maxConcurrent?: number;
  /**
   * When a swarm member hits an 'ask' permission, forward to this handler.
   * If not set, members use bypassPermissions mode.
   */
  permissionHandler?: PermissionHandler;
}

export interface SwarmStatus {
  members: SwarmMember[];
  messages: SwarmMessage[];
}

export interface SwarmEvents {
  type: "swarm_member_start" | "swarm_member_complete" | "swarm_member_failed" | "swarm_message";
  memberId: string;
  memberName: string;
  content?: string;
  error?: Error;
}
