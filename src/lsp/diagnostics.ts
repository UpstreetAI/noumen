import type { LspDiagnostic } from "./types.js";

const MAX_PENDING_PER_FILE = 50;

/**
 * Accumulates LSP diagnostics and provides them for injection into the agent context.
 */
export class DiagnosticRegistry {
  private pending = new Map<string, LspDiagnostic[]>();

  /**
   * Register diagnostics from an LSP server's publishDiagnostics notification.
   * Replaces all diagnostics for the given file.
   */
  register(diagnostics: LspDiagnostic[]): void {
    if (diagnostics.length === 0) return;

    const byFile = new Map<string, LspDiagnostic[]>();
    for (const d of diagnostics) {
      const existing = byFile.get(d.filePath) ?? [];
      existing.push(d);
      byFile.set(d.filePath, existing);
    }

    for (const [file, diags] of byFile) {
      this.pending.set(file, diags.slice(0, MAX_PENDING_PER_FILE));
    }
  }

  /**
   * Clear diagnostics for a specific file (e.g., after a write/edit).
   */
  clearForFile(filePath: string): void {
    this.pending.delete(filePath);
  }

  /**
   * Get all pending diagnostics and clear them.
   */
  flush(): LspDiagnostic[] {
    const all: LspDiagnostic[] = [];
    for (const diags of this.pending.values()) {
      all.push(...diags);
    }
    this.pending.clear();
    return all;
  }

  /**
   * Get pending diagnostics without clearing.
   */
  peek(): LspDiagnostic[] {
    const all: LspDiagnostic[] = [];
    for (const diags of this.pending.values()) {
      all.push(...diags);
    }
    return all;
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }
}
