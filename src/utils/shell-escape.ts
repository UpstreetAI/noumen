/**
 * Escape a string for safe interpolation into a single-quoted shell argument.
 * Handles embedded single quotes by ending the quote, inserting an escaped
 * quote, and re-opening. Wraps the result in single quotes.
 */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
