import type { DwarClient } from "../dwar/client.js";
import { DimaagError } from "../errors.js";

/** Mirrors Dwar `image.describe.allowed_media_types`. */
export const DESCRIBABLE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** Mirrors Dwar `image.describe.max_bytes`. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const MAX_ATTACHMENTS = 8;

export type MessageAttachment = {
  media_type: string;
  /** Raw base64 (no data-URL prefix). */
  data: string;
  filename?: string | undefined;
};

/**
 * Turn optional user text + attachments into a single text message for the
 * transcript and Dwar chat lanes. Images go through Dwar `/image/describe`;
 * other files become a short metadata stub (bytes are not forwarded).
 */
export async function patchMessageContent(
  dwar: DwarClient,
  content: string,
  attachments: MessageAttachment[] | undefined,
): Promise<string> {
  const text = content.trim();
  const files = attachments ?? [];

  if (files.length === 0) {
    if (!text) {
      throw new DimaagError(422, "invalid_request", "content or attachments required");
    }
    return text;
  }

  if (files.length > MAX_ATTACHMENTS) {
    throw new DimaagError(
      422,
      "invalid_request",
      `attachments exceeds max of ${MAX_ATTACHMENTS}`,
    );
  }

  const parts: string[] = [];
  if (text) {
    parts.push(text);
  }

  for (const [index, att] of files.entries()) {
    const mediaType = att.media_type.trim().toLowerCase();
    if (!mediaType) {
      throw new DimaagError(
        422,
        "invalid_request",
        `attachments[${index}].media_type is required`,
      );
    }
    const raw = decodeBase64(att.data, index);
    if (raw.length > MAX_ATTACHMENT_BYTES) {
      throw new DimaagError(
        422,
        "invalid_request",
        `attachments[${index}] exceeds max size of ${MAX_ATTACHMENT_BYTES} bytes`,
      );
    }

    if (DESCRIBABLE_IMAGE_TYPES.has(mediaType)) {
      const { description } = await dwar.describeImage({
        image: { media_type: mediaType, data: raw.toString("base64") },
      });
      const label = att.filename?.trim()
        ? `Image (${att.filename.trim()})`
        : "Image";
      parts.push(`[${label}]\n${description.trim()}`);
      continue;
    }

    const name = att.filename?.trim() || `attachment-${index + 1}`;
    parts.push(
      `[Attached file: ${name} (${mediaType}) — content not extracted; text lanes stay text-only]`,
    );
  }

  return parts.join("\n\n");
}

function decodeBase64(data: string, index: number): Buffer {
  const cleaned = data.replace(/\s+/g, "");
  if (!cleaned) {
    throw new DimaagError(
      422,
      "invalid_request",
      `attachments[${index}].data must not be empty`,
    );
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new DimaagError(
      422,
      "invalid_request",
      `attachments[${index}].data is not valid base64`,
    );
  }
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length === 0) {
    throw new DimaagError(
      422,
      "invalid_request",
      `attachments[${index}].data must not be empty`,
    );
  }
  return buf;
}
