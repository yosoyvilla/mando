// Composer attachment rules (see docs/superpowers/plans/2026-07-05-attachments.md,
// "Architecture" note). File data crosses the hub->agent tunnel
// double-base64-encoded (browser data-URL, then the proxy's http_request
// frame re-encodes the whole body) -- ~1.78x inflation over raw bytes -- and
// Bun's WebSocket defaults cap frames at 16MB with no override in this repo.
// The cap below is therefore a MESSAGE-TOTAL limit on raw file bytes (8MB
// raw -> ~14.2MB frame), not a per-file limit.
export const MAX_ATTACHMENT_FILES = 4;
export const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;

const ACCEPTED_MIME_PREFIX = "image/";
const ACCEPTED_PDF_MIME = "application/pdf";

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  dataUrl: string;
}

export type AttachmentValidationResult =
  | { ok: true }
  | { ok: false; error: string };

export function isAcceptedAttachmentMime(mime: string): boolean {
  return mime.startsWith(ACCEPTED_MIME_PREFIX) || mime === ACCEPTED_PDF_MIME;
}

/**
 * Validates a candidate file against the three composer rules: accepted
 * type, max file count, and max total bytes for the message. `existing` is
 * the set of attachments already queued for this message (excluding the
 * candidate).
 */
export function validate(
  file: File,
  existing: Pick<Attachment, "size">[],
): AttachmentValidationResult {
  if (!isAcceptedAttachmentMime(file.type)) {
    return {
      ok: false,
      error: "That file type is not supported — images and PDFs only.",
    };
  }

  if (existing.length >= MAX_ATTACHMENT_FILES) {
    return { ok: false, error: "Up to 4 files per message." };
  }

  const existingTotal = existing.reduce((sum, item) => sum + item.size, 0);
  if (existingTotal + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
    return {
      ok: false,
      error: "Attachments are limited to 8 MB per message.",
    };
  }

  return { ok: true };
}

/** Reads a File/Blob into a base64 data URL. */
export function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read file"));
      }
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export interface FilePartInput {
  type: "file";
  mime: string;
  filename: string;
  url: string;
}

/** Builds the opencode file parts sent ahead of the text part on submit. */
export function buildFileParts(attachments: Attachment[]): FilePartInput[] {
  return attachments.map((attachment) => ({
    type: "file",
    mime: attachment.mime,
    filename: attachment.name,
    url: attachment.dataUrl,
  }));
}

/** Client-only id for tracking a queued attachment (chip key + removal). */
export function createAttachmentId(): string {
  const cryptoObj =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalizes a paste/drop FileList (or array) into a plain File array. */
export function filesFromFileList(
  fileList: FileList | File[] | null | undefined,
): File[] {
  return fileList ? Array.from(fileList) : [];
}
