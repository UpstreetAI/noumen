import type { VirtualFs } from "../virtual/fs.js";
import type { Task, TaskCreateInput, TaskUpdateInput } from "./types.js";

/**
 * File-backed task store persisted on a VirtualFs instance.
 * Tasks are stored as individual JSON files under a configurable directory.
 */
export class TaskStore {
  private dir: string;
  private fs: VirtualFs;
  private nextId = 1;
  private initialized = false;

  constructor(fs: VirtualFs, dir: string) {
    this.fs = fs;
    this.dir = dir;
  }

  private async ensureDir(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.fs.mkdir(this.dir, { recursive: true });
    } catch {
      // may already exist
    }
    // Read existing tasks to determine next ID
    try {
      const files = await this.fs.readdir(this.dir);
      let maxId = 0;
      for (const f of files) {
        const match = f.name.match(/^(\d+)\.json$/);
        if (match) {
          maxId = Math.max(maxId, parseInt(match[1], 10));
        }
      }
      this.nextId = maxId + 1;
    } catch {
      // empty dir
    }
    this.initialized = true;
  }

  private taskPath(id: string): string {
    return `${this.dir}/${id}.json`;
  }

  async create(input: TaskCreateInput): Promise<Task> {
    await this.ensureDir();

    const id = String(this.nextId++);
    const now = new Date().toISOString();
    const task: Task = {
      id,
      subject: input.subject,
      description: input.description,
      status: "pending",
      blocks: [],
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.fs.writeFile(this.taskPath(id), JSON.stringify(task, null, 2));
    return task;
  }

  async get(id: string): Promise<Task | null> {
    await this.ensureDir();
    try {
      const content = await this.fs.readFile(this.taskPath(id));
      return JSON.parse(content) as Task;
    } catch {
      return null;
    }
  }

  async list(): Promise<Task[]> {
    await this.ensureDir();
    const tasks: Task[] = [];
    try {
      const files = await this.fs.readdir(this.dir);
      for (const f of files) {
        if (!f.name.endsWith(".json")) continue;
        try {
          const content = await this.fs.readFile(`${this.dir}/${f.name}`);
          tasks.push(JSON.parse(content) as Task);
        } catch {
          // skip corrupt files
        }
      }
    } catch {
      // empty
    }
    tasks.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
    return tasks;
  }

  async update(id: string, input: TaskUpdateInput): Promise<Task | null> {
    const task = await this.get(id);
    if (!task) return null;

    if (input.status !== undefined) task.status = input.status;
    if (input.description !== undefined) task.description = input.description;
    if (input.owner !== undefined) task.owner = input.owner;
    if (input.blockedBy !== undefined) {
      task.blockedBy = input.blockedBy;
      // Update reverse references
      const allTasks = await this.list();
      for (const t of allTasks) {
        const blocksIdx = t.blocks.indexOf(id);
        if (input.blockedBy.includes(t.id)) {
          if (blocksIdx === -1) t.blocks.push(id);
        } else {
          if (blocksIdx !== -1) t.blocks.splice(blocksIdx, 1);
        }
        await this.fs.writeFile(
          this.taskPath(t.id),
          JSON.stringify(t, null, 2),
        );
      }
    }

    task.updatedAt = new Date().toISOString();
    await this.fs.writeFile(this.taskPath(id), JSON.stringify(task, null, 2));
    return task;
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.fs.deleteFile(this.taskPath(id));
      return true;
    } catch {
      return false;
    }
  }
}
