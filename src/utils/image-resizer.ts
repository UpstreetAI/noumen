/**
 * Image resize / compress pipeline.
 *
 * Ported from claude-code's imageResizer.ts. Uses `sharp` (optional peer
 * dependency) for dimension caps, iterative quality reduction, and API
 * base64 size guards. Gracefully degrades when sharp is not installed.
 */

/** Maximum base64-encoded image size (API enforced by most providers). */
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024; // 5 MB

/** Target raw size before base64 encoding (base64 inflates by ~4/3). */
export const IMAGE_TARGET_RAW_SIZE = Math.floor(
  (API_IMAGE_MAX_BASE64_SIZE * 3) / 4,
); // ~3.75 MB

export const IMAGE_MAX_WIDTH = 8000;
export const IMAGE_MAX_HEIGHT = 8000;

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ResizedImage {
  buffer: Buffer;
  mediaType: string;
  dimensions?: ImageDimensions;
}

export interface CompressedImageResult {
  base64: string;
  mediaType: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sharp: any | null | undefined;

async function getSharp(): Promise<any | null> {
  if (_sharp !== undefined) return _sharp;
  try {
    // Dynamic import with variable to prevent TypeScript from resolving at compile time
    const moduleName = "sharp";
    const mod = await import(/* @vite-ignore */ moduleName);
    _sharp = mod.default ?? mod;
    return _sharp;
  } catch {
    _sharp = null;
    return null;
  }
}

/**
 * Resize and downsample an image buffer if it exceeds dimension or size
 * limits. Returns the (possibly unchanged) buffer with mediaType info.
 */
export async function maybeResizeAndDownsampleImageBuffer(
  imageBuffer: Buffer,
  originalSize: number,
  ext: string,
): Promise<ResizedImage> {
  const sharp = await getSharp();
  if (!sharp) {
    if (imageBuffer.length > IMAGE_TARGET_RAW_SIZE) {
      console.warn(
        `[noumen] Image is ${(imageBuffer.length / 1024 / 1024).toFixed(1)}MB ` +
          `but sharp is not installed — cannot resize. Install sharp for image optimization.`,
      );
    }
    return {
      buffer: imageBuffer,
      mediaType: extToMediaType(ext),
    };
  }

  let img = sharp(imageBuffer);
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  let needsResize =
    width > IMAGE_MAX_WIDTH ||
    height > IMAGE_MAX_HEIGHT ||
    imageBuffer.length > IMAGE_TARGET_RAW_SIZE;

  if (!needsResize) {
    return {
      buffer: imageBuffer,
      mediaType: extToMediaType(ext),
      dimensions: { width, height },
    };
  }

  // Dimension cap
  if (width > IMAGE_MAX_WIDTH || height > IMAGE_MAX_HEIGHT) {
    const scale = Math.min(IMAGE_MAX_WIDTH / width, IMAGE_MAX_HEIGHT / height);
    const newWidth = Math.round(width * scale);
    const newHeight = Math.round(height * scale);
    img = img.resize(newWidth, newHeight, { fit: "inside", withoutEnlargement: true });
  }

  // Try JPEG at decreasing quality levels
  const qualities = [85, 60, 40];
  for (const q of qualities) {
    const buf = await img.jpeg({ quality: q, mozjpeg: true }).toBuffer();
    if (buf.length <= IMAGE_TARGET_RAW_SIZE) {
      const jpgMeta = await sharp(buf).metadata();
      return {
        buffer: buf,
        mediaType: "jpeg",
        dimensions: {
          width: jpgMeta.width ?? 0,
          height: jpgMeta.height ?? 0,
        },
      };
    }
  }

  // Try PNG palette mode as last resort
  const pngBuf = await img.png({ palette: true, quality: 40 }).toBuffer();
  if (pngBuf.length <= IMAGE_TARGET_RAW_SIZE) {
    const pngMeta = await sharp(pngBuf).metadata();
    return {
      buffer: pngBuf,
      mediaType: "png",
      dimensions: {
        width: pngMeta.width ?? 0,
        height: pngMeta.height ?? 0,
      },
    };
  }

  // Return best-effort JPEG Q40 even if over budget
  const fallback = await img.jpeg({ quality: 40, mozjpeg: true }).toBuffer();
  const fallbackMeta = await sharp(fallback).metadata();
  return {
    buffer: fallback,
    mediaType: "jpeg",
    dimensions: {
      width: fallbackMeta.width ?? 0,
      height: fallbackMeta.height ?? 0,
    },
  };
}

/**
 * Decode base64 image block, resize, re-encode.
 */
export async function maybeResizeAndDownsampleImageBlock(imageBlock: {
  data: string;
  media_type: string;
}): Promise<{
  data: string;
  media_type: string;
  dimensions?: ImageDimensions;
}> {
  const imageBuffer = Buffer.from(imageBlock.data, "base64");
  const ext = imageBlock.media_type.split("/")[1] || "png";

  const resized = await maybeResizeAndDownsampleImageBuffer(
    imageBuffer,
    imageBuffer.length,
    ext,
  );

  return {
    data: resized.buffer.toString("base64"),
    media_type: `image/${resized.mediaType}`,
    dimensions: resized.dimensions,
  };
}

/**
 * Compress an image to fit within a token budget.
 * Token formula: tokens ≈ base64_chars × 0.125
 */
export async function compressImageBufferWithTokenLimit(
  imageBuffer: Buffer,
  maxTokens: number,
  originalMediaType?: string,
): Promise<CompressedImageResult> {
  const maxBase64Chars = Math.floor(maxTokens / 0.125);
  const maxBytes = Math.floor(maxBase64Chars * 0.75);

  const sharp = await getSharp();
  if (!sharp) {
    const base64 = imageBuffer.toString("base64");
    return {
      base64,
      mediaType: originalMediaType?.split("/")[1] || "png",
    };
  }

  const qualities = [85, 60, 40, 20];
  for (const q of qualities) {
    const buf = await sharp(imageBuffer)
      .jpeg({ quality: q, mozjpeg: true })
      .toBuffer();
    if (buf.length <= maxBytes) {
      return { base64: buf.toString("base64"), mediaType: "jpeg" };
    }
  }

  // Progressive dimension reduction
  const meta = await sharp(imageBuffer).metadata();
  let w = meta.width ?? 800;
  let h = meta.height ?? 600;

  for (let scale = 0.75; scale >= 0.25; scale -= 0.25) {
    const nw = Math.round(w * scale);
    const nh = Math.round(h * scale);
    const buf = await sharp(imageBuffer)
      .resize(nw, nh, { fit: "inside" })
      .jpeg({ quality: 40, mozjpeg: true })
      .toBuffer();
    if (buf.length <= maxBytes) {
      return { base64: buf.toString("base64"), mediaType: "jpeg" };
    }
  }

  // Best effort
  const buf = await sharp(imageBuffer)
    .resize(Math.round(w * 0.25), Math.round(h * 0.25), { fit: "inside" })
    .jpeg({ quality: 20, mozjpeg: true })
    .toBuffer();
  return { base64: buf.toString("base64"), mediaType: "jpeg" };
}

function extToMediaType(ext: string): string {
  const lower = ext.toLowerCase().replace(/^\./, "");
  switch (lower) {
    case "jpg":
    case "jpeg":
      return "jpeg";
    case "png":
      return "png";
    case "gif":
      return "gif";
    case "webp":
      return "webp";
    case "svg":
      return "svg+xml";
    default:
      return "png";
  }
}

export const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);

/**
 * Create dimension metadata text for the model (helps with coordinate reasoning).
 */
export function createImageMetadataText(dims: ImageDimensions): string {
  return `Image dimensions: ${dims.width}×${dims.height}px`;
}
