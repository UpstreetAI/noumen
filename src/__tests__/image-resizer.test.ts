import { describe, it, expect } from "vitest";
import {
  IMAGE_EXTENSIONS,
  IMAGE_MAX_WIDTH,
  IMAGE_MAX_HEIGHT,
  API_IMAGE_MAX_BASE64_SIZE,
  createImageMetadataText,
} from "../utils/image-resizer.js";
import { estimateMessageTokens } from "../utils/tokens.js";

describe("IMAGE_EXTENSIONS", () => {
  it("includes common image formats", () => {
    expect(IMAGE_EXTENSIONS.has(".png")).toBe(true);
    expect(IMAGE_EXTENSIONS.has(".jpg")).toBe(true);
    expect(IMAGE_EXTENSIONS.has(".jpeg")).toBe(true);
    expect(IMAGE_EXTENSIONS.has(".gif")).toBe(true);
    expect(IMAGE_EXTENSIONS.has(".webp")).toBe(true);
    expect(IMAGE_EXTENSIONS.has(".svg")).toBe(true);
  });

  it("does not include non-image formats", () => {
    expect(IMAGE_EXTENSIONS.has(".txt")).toBe(false);
    expect(IMAGE_EXTENSIONS.has(".ts")).toBe(false);
    expect(IMAGE_EXTENSIONS.has(".json")).toBe(false);
  });
});

describe("createImageMetadataText", () => {
  it("formats width×height", () => {
    const text = createImageMetadataText({ width: 1920, height: 1080 });
    expect(text).toBe("Image dimensions: 1920×1080px");
  });
});

describe("image token estimation", () => {
  it("uses base64 length for images with data", () => {
    const base64 = "A".repeat(1000);
    const msg = {
      role: "user",
      content: [{ type: "image", data: base64, media_type: "image/png" }],
    };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(85);
    expect(tokens).toBe(4 + Math.ceil(1000 * 0.125)); // overhead + image tokens
  });

  it("uses MIN_TOKENS_PER_IMAGE for image_url type", () => {
    const msg = {
      role: "user",
      content: [{ type: "image_url", url: "https://example.com/image.png" }],
    };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBe(4 + 85); // overhead + MIN_TOKENS_PER_IMAGE
  });

  it("uses base64 length floor (at least 85) for small images", () => {
    const base64 = "QQ=="; // 4 chars * 0.125 = 0.5, should floor to 85
    const msg = {
      role: "user",
      content: [{ type: "image", data: base64, media_type: "image/png" }],
    };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBe(4 + 85); // overhead + min
  });
});

describe("constants", () => {
  it("API_IMAGE_MAX_BASE64_SIZE is 5MB", () => {
    expect(API_IMAGE_MAX_BASE64_SIZE).toBe(5 * 1024 * 1024);
  });

  it("dimension caps are 8000", () => {
    expect(IMAGE_MAX_WIDTH).toBe(8000);
    expect(IMAGE_MAX_HEIGHT).toBe(8000);
  });
});
