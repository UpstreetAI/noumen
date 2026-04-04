import { describe, it, expect } from "vitest";
import {
  normalizeQuotes,
  findActualString,
  countOccurrences,
  preserveQuoteStyle,
  stripTrailingWhitespace,
} from "../tools/edit-utils.js";

describe("normalizeQuotes", () => {
  it("converts curly single quotes to straight", () => {
    expect(normalizeQuotes("\u2018hello\u2019")).toBe("'hello'");
  });

  it("converts curly double quotes to straight", () => {
    expect(normalizeQuotes("\u201Chello\u201D")).toBe('"hello"');
  });

  it("leaves straight quotes unchanged", () => {
    expect(normalizeQuotes("'hello' \"world\"")).toBe("'hello' \"world\"");
  });

  it("handles mixed quotes", () => {
    expect(normalizeQuotes("\u2018it\u2019s a \u201Ctest\u201D")).toBe(
      "'it's a \"test\"",
    );
  });

  it("handles empty string", () => {
    expect(normalizeQuotes("")).toBe("");
  });
});

describe("findActualString", () => {
  it("returns searchString on exact match", () => {
    const result = findActualString("hello world", "world");
    expect(result).toBe("world");
  });

  it("returns null when no match at all", () => {
    const result = findActualString("hello world", "foobar");
    expect(result).toBeNull();
  });

  it("finds match via quote normalization (file has curly, search has straight)", () => {
    const fileContent = "const msg = \u201Chello world\u201D;";
    const searchString = 'const msg = "hello world";';
    const result = findActualString(fileContent, searchString);
    expect(result).not.toBeNull();
    // The returned string should be the actual file bytes
    expect(result).toContain("\u201C");
    expect(result).toContain("\u201D");
  });

  it("finds match via quote normalization (file has straight, search has curly)", () => {
    const fileContent = 'const msg = "hello world";';
    const searchString = "const msg = \u201Chello world\u201D;";
    const result = findActualString(fileContent, searchString);
    expect(result).not.toBeNull();
    expect(result).toContain('"');
    expect(result).not.toContain("\u201C");
  });

  it("prefers exact match over normalized match", () => {
    const content = "hello 'world'";
    const search = "hello 'world'";
    const result = findActualString(content, search);
    expect(result).toBe(search);
  });
});

describe("countOccurrences", () => {
  it("counts exact matches", () => {
    expect(countOccurrences("aaa", "a")).toBe(3);
  });

  it("counts via normalization", () => {
    const haystack = "\u201Chello\u201D and \u201Chello\u201D";
    expect(countOccurrences(haystack, '"hello"')).toBe(2);
  });

  it("returns 0 when no match", () => {
    expect(countOccurrences("hello world", "foobar")).toBe(0);
  });

  it("handles overlapping: counts non-overlapping occurrences", () => {
    expect(countOccurrences("aaa", "aa")).toBe(2);
  });
});

describe("preserveQuoteStyle", () => {
  it("returns newString unchanged when no normalization happened", () => {
    const result = preserveQuoteStyle("hello", "hello", "world");
    expect(result).toBe("world");
  });

  it("converts straight to curly singles when file uses curly", () => {
    const oldString = "'hello'";
    const actualOldString = "\u2018hello\u2019";
    const newString = "'world'";
    const result = preserveQuoteStyle(oldString, actualOldString, newString);
    expect(result).toContain("\u2018");
    expect(result).toContain("\u2019");
  });

  it("converts straight to curly doubles when file uses curly", () => {
    const oldString = '"hello"';
    const actualOldString = "\u201Chello\u201D";
    const newString = '"world"';
    const result = preserveQuoteStyle(oldString, actualOldString, newString);
    expect(result).toContain("\u201C");
    expect(result).toContain("\u201D");
  });

  it("leaves newString alone when file uses straight quotes", () => {
    const oldString = "\u201Chello\u201D";
    const actualOldString = '"hello"';
    const newString = '"world"';
    const result = preserveQuoteStyle(oldString, actualOldString, newString);
    expect(result).toBe('"world"');
  });
});

describe("stripTrailingWhitespace", () => {
  it("strips trailing spaces", () => {
    expect(stripTrailingWhitespace("hello   \n")).toBe("hello\n");
  });

  it("strips trailing tabs", () => {
    expect(stripTrailingWhitespace("hello\t\t\n")).toBe("hello\n");
  });

  it("strips trailing mixed whitespace", () => {
    expect(stripTrailingWhitespace("hello \t \n")).toBe("hello\n");
  });

  it("preserves CRLF line endings", () => {
    expect(stripTrailingWhitespace("hello   \r\nworld   \r\n")).toBe(
      "hello\r\nworld\r\n",
    );
  });

  it("preserves CR line endings", () => {
    expect(stripTrailingWhitespace("hello   \rworld   \r")).toBe(
      "hello\rworld\r",
    );
  });

  it("preserves LF line endings", () => {
    expect(stripTrailingWhitespace("hello   \nworld   \n")).toBe(
      "hello\nworld\n",
    );
  });

  it("handles multiline", () => {
    const input = "  line1  \n  line2\t\n  line3   ";
    const expected = "  line1\n  line2\n  line3";
    expect(stripTrailingWhitespace(input)).toBe(expected);
  });

  it("handles empty string", () => {
    expect(stripTrailingWhitespace("")).toBe("");
  });

  it("handles no trailing whitespace", () => {
    expect(stripTrailingWhitespace("hello\nworld")).toBe("hello\nworld");
  });
});
