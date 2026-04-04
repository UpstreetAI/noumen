export interface CommandClassification {
  /** True when every sub-command in the pipeline is read-only. */
  isReadOnly: boolean;
  /** True when any sub-command matches a destructive pattern. */
  isDestructive: boolean;
  /** Human-readable explanation of the classification. */
  reason?: string;
}

export interface ShellSafetyConfig {
  /** Extra commands to treat as read-only (merged with built-in list). */
  extraReadOnlyCommands?: string[];
  /** Extra regex patterns to treat as destructive. */
  extraDestructivePatterns?: RegExp[];
}
