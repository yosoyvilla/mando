import { describe, it, expect } from "bun:test";
import {
  MAX_ATTACHMENT_FILES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  validate,
  fileToDataUrl,
  buildFileParts,
  filesFromFileList,
} from "../src/lib/attachments";

function makeFile(
  name: string,
  mime: string,
  sizeBytes: number,
  content = "x",
): File {
  const bytes = new Uint8Array(sizeBytes).fill(content.charCodeAt(0));
  return new File([bytes], name, { type: mime });
}

describe("validate", () => {
  it("rejects unsupported mime types", () => {
    const file = makeFile("notes.txt", "text/plain", 10);
    const result = validate(file, []);
    expect(result).toEqual({
      ok: false,
      error: "That file type is not supported — images and PDFs only.",
    });
  });

  it("accepts image/* files with no existing attachments", () => {
    const file = makeFile("photo.png", "image/png", 1024);
    expect(validate(file, [])).toEqual({ ok: true });
  });

  it("accepts application/pdf files", () => {
    const file = makeFile("doc.pdf", "application/pdf", 1024);
    expect(validate(file, [])).toEqual({ ok: true });
  });

  it("rejects a 5th file even when each file is small", () => {
    const existing = Array.from({ length: MAX_ATTACHMENT_FILES }, () => ({
      size: 100,
    }));
    const file = makeFile("photo.png", "image/png", 100);
    expect(validate(file, existing)).toEqual({
      ok: false,
      error: "Up to 4 files per message.",
    });
  });

  it("rejects when the message total would exceed 8MB", () => {
    const existing = [{ size: MAX_ATTACHMENT_TOTAL_BYTES - 100 }];
    const file = makeFile("photo.png", "image/png", 200);
    expect(validate(file, existing)).toEqual({
      ok: false,
      error: "Attachments are limited to 8 MB per message.",
    });
  });

  it("accepts a file that lands exactly at the 8MB total", () => {
    const existing = [{ size: MAX_ATTACHMENT_TOTAL_BYTES - 200 }];
    const file = makeFile("photo.png", "image/png", 200);
    expect(validate(file, existing)).toEqual({ ok: true });
  });

  it("checks type before count or size", () => {
    const existing = Array.from({ length: MAX_ATTACHMENT_FILES }, () => ({
      size: 100,
    }));
    const file = makeFile("notes.txt", "text/plain", 100);
    expect(validate(file, existing)).toEqual({
      ok: false,
      error: "That file type is not supported — images and PDFs only.",
    });
  });
});

describe("fileToDataUrl", () => {
  it("round-trips a small blob into a base64 data URL", async () => {
    const blob = new Blob(["hello"], { type: "text/plain" });
    const dataUrl = await fileToDataUrl(blob);
    expect(dataUrl.startsWith("data:text/plain;base64,")).toBe(true);

    const base64 = dataUrl.split(",")[1] ?? "";
    const decoded = Buffer.from(base64, "base64").toString("utf-8");
    expect(decoded).toBe("hello");
  });
});

describe("buildFileParts", () => {
  it("maps attachments to file part inputs in order", () => {
    const parts = buildFileParts([
      { id: "1", name: "a.png", mime: "image/png", size: 1, dataUrl: "data:image/png;base64,AA==" },
      { id: "2", name: "b.pdf", mime: "application/pdf", size: 2, dataUrl: "data:application/pdf;base64,BB==" },
    ]);

    expect(parts).toEqual([
      { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AA==" },
      { type: "file", mime: "application/pdf", filename: "b.pdf", url: "data:application/pdf;base64,BB==" },
    ]);
  });

  it("returns an empty array for no attachments", () => {
    expect(buildFileParts([])).toEqual([]);
  });
});

describe("filesFromFileList", () => {
  it("returns an empty array for null/undefined", () => {
    expect(filesFromFileList(null)).toEqual([]);
    expect(filesFromFileList(undefined)).toEqual([]);
  });

  it("converts a FileList-like array into a plain array", () => {
    const file = makeFile("a.png", "image/png", 10);
    expect(filesFromFileList([file])).toEqual([file]);
  });
});
