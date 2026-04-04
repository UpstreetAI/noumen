import type { AIProvider } from "./providers/types.js";
import type { VirtualFs } from "./virtual/fs.js";
import type { VirtualComputer } from "./virtual/computer.js";
import type { SkillDefinition } from "./skills/types.js";
import type { SessionInfo } from "./session/types.js";
import { SessionStorage } from "./session/storage.js";
import { Thread, type ThreadOptions } from "./thread.js";
import { createAutoCompactConfig } from "./compact/auto-compact.js";
import { buildUserContext } from "./prompt/context.js";

export interface CodeOptions {
  aiProvider: AIProvider;
  virtualFs: VirtualFs;
  virtualComputer: VirtualComputer;
  options?: {
    sessionDir?: string;
    skills?: SkillDefinition[];
    skillsPaths?: string[];
    systemPrompt?: string;
    model?: string;
    maxTokens?: number;
    autoCompact?: boolean;
    autoCompactThreshold?: number;
    cwd?: string;
  };
}

export class Code {
  private aiProvider: AIProvider;
  private fs: VirtualFs;
  private computer: VirtualComputer;
  private sessionDir: string;
  private skills: SkillDefinition[];
  private skillsPaths: string[];
  private systemPrompt?: string;
  private model?: string;
  private maxTokens?: number;
  private autoCompactEnabled: boolean;
  private autoCompactThreshold?: number;
  private cwd: string;
  private storage: SessionStorage;
  private resolvedSkills: SkillDefinition[] | null = null;

  constructor(opts: CodeOptions) {
    this.aiProvider = opts.aiProvider;
    this.fs = opts.virtualFs;
    this.computer = opts.virtualComputer;
    this.sessionDir = opts.options?.sessionDir ?? ".noumen/sessions";
    this.skills = opts.options?.skills ?? [];
    this.skillsPaths = opts.options?.skillsPaths ?? [];
    this.systemPrompt = opts.options?.systemPrompt;
    this.model = opts.options?.model;
    this.maxTokens = opts.options?.maxTokens;
    this.autoCompactEnabled = opts.options?.autoCompact ?? true;
    this.autoCompactThreshold = opts.options?.autoCompactThreshold;
    this.cwd = opts.options?.cwd ?? "/";
    this.storage = new SessionStorage(this.fs, this.sessionDir);
  }

  private async getSkills(): Promise<SkillDefinition[]> {
    if (this.resolvedSkills) return this.resolvedSkills;

    const ctx = await buildUserContext({
      fs: this.fs,
      skillsPaths: this.skillsPaths,
      inlineSkills: this.skills,
    });

    this.resolvedSkills = ctx.skills;
    return this.resolvedSkills;
  }

  createThread(opts?: ThreadOptions): Thread {
    const autoCompact = createAutoCompactConfig({
      enabled: this.autoCompactEnabled,
      threshold: this.autoCompactThreshold,
    });

    // Eagerly resolve skills if already cached; otherwise thread will use
    // whatever was passed at construction time. Skills from paths require
    // async loading, so we kick it off but use what's available synchronously.
    const skills = this.resolvedSkills ?? this.skills;

    return new Thread(
      {
        aiProvider: this.aiProvider,
        fs: this.fs,
        computer: this.computer,
        sessionDir: this.sessionDir,
        skills,
        systemPrompt: this.systemPrompt,
        model: this.model,
        maxTokens: this.maxTokens,
        autoCompact,
      },
      {
        ...opts,
        cwd: opts?.cwd ?? this.cwd,
      },
    );
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.storage.listSessions();
  }

  /**
   * Pre-resolve skills from paths. Call this once after construction if using
   * skillsPaths, so that createThread() has skills available synchronously.
   */
  async init(): Promise<void> {
    await this.getSkills();
  }
}
