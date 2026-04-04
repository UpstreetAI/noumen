import type { ContextFile, ContextScope } from "./types.js";

const SCOPE_LABELS: Record<ContextScope, string> = {
  managed: "managed instructions",
  user: "user instructions",
  project: "project instructions",
  local: "local instructions",
};

const CONTEXT_PREAMBLE =
  "The following project instructions customize your behavior. " +
  "Follow them unless they conflict with explicit user requests.";

/**
 * Format loaded context files into a system prompt section.
 *
 * Files are rendered in array order (lowest to highest priority).
 * Included sub-files are inlined immediately after their parent.
 */
export function buildProjectContextSection(
  files: ContextFile[],
  filter?: ContextScope[],
): string {
  const applicable = filter
    ? files.filter((f) => filter.includes(f.scope))
    : files;

  if (applicable.length === 0) return "";

  const sections: string[] = [CONTEXT_PREAMBLE, ""];

  for (const file of applicable) {
    renderFile(file, sections);
  }

  return sections.join("\n");
}

function renderFile(file: ContextFile, out: string[]): void {
  const label = SCOPE_LABELS[file.scope];
  out.push(`Contents of ${file.path} (${label})\n`);
  out.push(file.content);
  out.push("");

  if (file.includes) {
    for (const inc of file.includes) {
      renderFile(inc, out);
    }
  }
}
