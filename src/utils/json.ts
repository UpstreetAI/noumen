export function jsonStringify(value: unknown): string {
  return JSON.stringify(value);
}

export function parseJSONL<T = unknown>(text: string): T[] {
  const results: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed) as T);
    } catch {
      // skip malformed lines
    }
  }
  return results;
}
