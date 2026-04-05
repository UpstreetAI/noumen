export function jsonStringify(value: unknown): string {
  return JSON.stringify(value);
}

export interface ParseJSONLResult<T> {
  entries: T[];
  droppedLines: number;
}

export function parseJSONL<T = unknown>(text: string): T[] {
  return parseJSONLWithDiag<T>(text).entries;
}

export function parseJSONLWithDiag<T = unknown>(text: string): ParseJSONLResult<T> {
  const entries: T[] = [];
  let droppedLines = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as T);
    } catch {
      droppedLines++;
    }
  }
  if (droppedLines > 0) {
    console.warn(`[noumen/session] JSONL parse: ${droppedLines} malformed line(s) dropped`);
  }
  return { entries, droppedLines };
}
