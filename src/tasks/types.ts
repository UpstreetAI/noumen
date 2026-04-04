export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: string;
  subject: string;
  description?: string;
  status: TaskStatus;
  owner?: string;
  /** Task IDs that this task blocks (downstream dependents). */
  blocks: string[];
  /** Task IDs that must complete before this task can start. */
  blockedBy: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskCreateInput {
  subject: string;
  description?: string;
}

export interface TaskUpdateInput {
  status?: TaskStatus;
  description?: string;
  owner?: string;
  blockedBy?: string[];
}
