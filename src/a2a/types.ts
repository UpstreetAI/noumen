/**
 * Agent2Agent (A2A) protocol types per the Google A2A specification.
 * https://google.github.io/A2A/specification/
 */

// ── Agent Card ──────────────────────────────────────────────────────────────

export interface AgentCard {
  name: string;
  description?: string;
  url: string;
  provider?: {
    organization: string;
    url?: string;
  };
  version: string;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  authentication?: {
    schemes: string[];
    credentials?: string;
  };
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills?: AgentSkill[];
}

export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

// ── Task lifecycle ──────────────────────────────────────────────────────────

export type TaskStatus =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

export interface Task {
  id: string;
  sessionId?: string;
  status: TaskState;
  history?: Message[];
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
}

export interface TaskState {
  state: TaskStatus;
  message?: Message;
  timestamp?: string;
}

// ── Messages and parts ──────────────────────────────────────────────────────

export interface Message {
  role: "user" | "agent";
  parts: Part[];
  metadata?: Record<string, unknown>;
}

export type Part = TextPart | FilePart | DataPart;

export interface TextPart {
  type: "text";
  text: string;
}

export interface FilePart {
  type: "file";
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string; // base64
    uri?: string;
  };
}

export interface DataPart {
  type: "data";
  data: Record<string, unknown>;
}

export interface Artifact {
  name?: string;
  description?: string;
  parts: Part[];
  index?: number;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

// ── JSON-RPC method params ──────────────────────────────────────────────────

export interface TaskSendParams {
  id?: string;
  sessionId?: string;
  message: Message;
  metadata?: Record<string, unknown>;
}

export interface TaskGetParams {
  id: string;
}

export interface TaskCancelParams {
  id: string;
}

// ── SSE streaming ───────────────────────────────────────────────────────────

export interface TaskStatusUpdateEvent {
  type: "status";
  taskId: string;
  status: TaskState;
  final: boolean;
}

export interface TaskArtifactUpdateEvent {
  type: "artifact";
  taskId: string;
  artifact: Artifact;
}

export type TaskStreamEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

// ── A2A method constants ────────────────────────────────────────────────────

export const A2A_METHODS = {
  TASKS_SEND: "tasks/send",
  TASKS_SEND_SUBSCRIBE: "tasks/sendSubscribe",
  TASKS_GET: "tasks/get",
  TASKS_CANCEL: "tasks/cancel",
  TASKS_PUSH_NOTIFICATION: "tasks/pushNotification",
  TASKS_RESUBSCRIBE: "tasks/resubscribe",
} as const;
