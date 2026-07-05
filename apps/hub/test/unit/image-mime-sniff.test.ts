import { test, expect } from "bun:test";
import { sniffImageMime } from "../../src/images/provider-client";

// Minimal real magic-number prefixes for each format -- content after the
// magic bytes is irrelevant to sniffing, so these are truncated/fake
// beyond the signature itself.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP_MAGIC = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
const GIF87A_MAGIC = Buffer.from("GIF87a" + "junk");
const GIF89A_MAGIC = Buffer.from("GIF89a" + "junk");

test("sniffImageMime identifies a PNG by its 8-byte signature", () => {
  expect(sniffImageMime(PNG_MAGIC)).toBe("image/png");
});

test("sniffImageMime identifies a JPEG even when mislabeled by the provider (the flux debt)", () => {
  expect(sniffImageMime(JPEG_MAGIC)).toBe("image/jpeg");
});

test("sniffImageMime identifies a WEBP by its RIFF....WEBP container", () => {
  expect(sniffImageMime(WEBP_MAGIC)).toBe("image/webp");
});

test("sniffImageMime identifies both GIF87a and GIF89a variants", () => {
  expect(sniffImageMime(GIF87A_MAGIC)).toBe("image/gif");
  expect(sniffImageMime(GIF89A_MAGIC)).toBe("image/gif");
});

test("sniffImageMime falls back to a generic binary type for an unrecognized signature", () => {
  expect(sniffImageMime(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe("application/octet-stream");
});

test("sniffImageMime does not throw on very short input", () => {
  expect(sniffImageMime(Buffer.alloc(0))).toBe("application/octet-stream");
  expect(sniffImageMime(Buffer.from([0xff]))).toBe("application/octet-stream");
});
