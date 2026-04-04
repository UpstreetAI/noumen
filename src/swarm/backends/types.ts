import type { SwarmMember, SwarmMemberConfig } from "../types.js";
import type { StreamEvent } from "../../session/types.js";

/**
 * Backend interface for executing swarm members.
 * The in-process backend runs Thread instances concurrently.
 * Custom backends can spawn external processes, containers, etc.
 */
export interface SwarmBackend {
  spawn(
    config: SwarmMemberConfig,
    member: SwarmMember,
  ): AsyncGenerator<StreamEvent, string, unknown>;

  kill(memberId: string): Promise<void>;
}
