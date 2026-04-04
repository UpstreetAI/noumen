/**
 * Edit utilities: fuzzy matching and quote normalization.
 *
 * When the model produces an `old_string` with smart/curly quotes that
 * don't literally match the file (or vice versa), these helpers find the
 * actual on-disk string and rewrite the replacement to preserve the file's
 * quote style.
 */

const LEFT_SINGLE_CURLY = "\u2018";  // '
const RIGHT_SINGLE_CURLY = "\u2019"; // '
const LEFT_DOUBLE_CURLY = "\u201C";  // "
const RIGHT_DOUBLE_CURLY = "\u201D"; // "

/**
 * Replace curly/smart quotes with their ASCII equivalents.
 */
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY, "'")
    .replaceAll(RIGHT_SINGLE_CURLY, "'")
    .replaceAll(LEFT_DOUBLE_CURLY, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY, '"');
}

/**
 * Find the actual substring in `fileContent` that matches `searchString`,
 * allowing for quote-normalization differences.
 *
 * Returns the literal bytes from the file that match (which may contain
 * curly quotes even though `searchString` used straight quotes), or null
 * if no match is found even after normalization.
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  // Fast path: exact match
  if (fileContent.includes(searchString)) {
    return searchString;
  }

  // Normalize both and try again
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);

  const searchIndex = normalizedFile.indexOf(normalizedSearch);
  if (searchIndex !== -1) {
    return fileContent.substring(searchIndex, searchIndex + searchString.length);
  }

  return null;
}

/**
 * Count occurrences of `needle` in `haystack` using the same fuzzy matching
 * as `findActualString` — normalizes quotes before counting.
 */
export function countOccurrences(
  haystack: string,
  needle: string,
): number {
  // Use the normalized form for counting
  const normalizedNeedle = normalizeQuotes(needle);
  const normalizedHaystack = normalizeQuotes(haystack);

  let count = 0;
  let pos = 0;
  while (true) {
    const idx = normalizedHaystack.indexOf(normalizedNeedle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + 1;
  }
  return count;
}

/**
 * Detect whether a string uses curly quotes and which style.
 */
function usesCurlyQuotes(str: string): {
  singleCurly: boolean;
  doubleCurly: boolean;
} {
  return {
    singleCurly:
      str.includes(LEFT_SINGLE_CURLY) || str.includes(RIGHT_SINGLE_CURLY),
    doubleCurly:
      str.includes(LEFT_DOUBLE_CURLY) || str.includes(RIGHT_DOUBLE_CURLY),
  };
}

/**
 * When the file uses curly quotes but the model provided straight quotes
 * (or vice versa), rewrite `newString` to match the file's quote style.
 *
 * If `oldString === actualOldString`, no normalization happened and the
 * replacement is returned unchanged.
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) {
    return newString;
  }

  const fileStyle = usesCurlyQuotes(actualOldString);
  let result = newString;

  // File uses curly singles — convert straight singles to curly
  if (fileStyle.singleCurly) {
    result = convertStraightToCurlySingle(result);
  }

  // File uses curly doubles — convert straight doubles to curly
  if (fileStyle.doubleCurly) {
    result = convertStraightToCurlyDouble(result);
  }

  return result;
}

/**
 * Convert straight single quotes to curly, with simple open/close heuristics.
 * A quote after whitespace or at start-of-string opens; otherwise closes.
 */
function convertStraightToCurlySingle(str: string): string {
  let result = "";
  let inWord = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'") {
      const prev = i > 0 ? str[i - 1] : " ";
      if (/\s/.test(prev) || prev === "(" || prev === "[" || prev === "{") {
        result += LEFT_SINGLE_CURLY;
        inWord = true;
      } else {
        result += RIGHT_SINGLE_CURLY;
        inWord = false;
      }
    } else {
      result += ch;
      inWord = /\w/.test(ch);
    }
  }
  return result;
}

/**
 * Convert straight double quotes to curly, alternating open/close.
 */
function convertStraightToCurlyDouble(str: string): string {
  let result = "";
  let open = true;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"') {
      result += open ? LEFT_DOUBLE_CURLY : RIGHT_DOUBLE_CURLY;
      open = !open;
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Strip trailing whitespace (spaces/tabs) from each line, preserving
 * the line-ending style (CRLF, LF, CR).
 */
export function stripTrailingWhitespace(str: string): string {
  // Split on line endings but keep the separators
  const parts = str.split(/(\r\n|\n|\r)/);
  const result: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // Every other element is a separator
    if (i % 2 === 0) {
      result.push(part.replace(/[\t ]+$/, ""));
    } else {
      result.push(part);
    }
  }

  return result.join("");
}
