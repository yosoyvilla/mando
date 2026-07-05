import { test, expect } from "bun:test";
import { mkdtemp, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteImageFile, ImagePathError, readImageFile, writeImageFile } from "../../src/images/storage";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mando-images-test-"));
}

test("writeImageFile then readImageFile round-trips the exact bytes, creating the dir if missing", async () => {
  const dir = await freshDir();
  await rm(dir, { recursive: true, force: true }); // exercise mkdir -p from a dir that doesn't exist yet
  const id = "11111111-1111-1111-1111-111111111111";
  const bytes = Buffer.from("hello image bytes");

  await writeImageFile(dir, id, bytes);
  const read = await readImageFile(dir, id);

  expect(read.equals(bytes)).toBe(true);
});

test("deleteImageFile removes the file, and is a no-op when the file is already gone", async () => {
  const dir = await freshDir();
  const id = "22222222-2222-2222-2222-222222222222";
  await writeImageFile(dir, id, Buffer.from("x"));

  await deleteImageFile(dir, id);
  await expect(readImageFile(dir, id)).rejects.toThrow();

  // Deleting again (already-missing file) must not throw.
  await deleteImageFile(dir, id);
});

test("write/read/delete reject an id that is not a plain UUID (path traversal attempt)", async () => {
  const dir = await freshDir();
  const traversal = "../../etc/passwd";

  await expect(writeImageFile(dir, traversal, Buffer.from("x"))).rejects.toThrow(ImagePathError);
  await expect(readImageFile(dir, traversal)).rejects.toThrow(ImagePathError);
  await expect(deleteImageFile(dir, traversal)).rejects.toThrow(ImagePathError);
});

test("write/read/delete reject an id containing a path separator even without '..'", async () => {
  const dir = await freshDir();
  await expect(writeImageFile(dir, "sub/dir-id", Buffer.from("x"))).rejects.toThrow(ImagePathError);
});

test("resolves within a symlinked image directory without escaping it (realpath-normalized containment)", async () => {
  const real = await freshDir();
  const linkParent = await freshDir();
  const link = join(linkParent, "images-link");
  await symlink(real, link, "dir");

  const id = "33333333-3333-3333-3333-333333333333";
  await writeImageFile(link, id, Buffer.from("via-symlink"));

  // Readable both through the symlink and directly via the real dir --
  // proving the file landed inside `real`, not somewhere the symlink's
  // literal (unresolved) path would suggest.
  expect((await readImageFile(link, id)).toString()).toBe("via-symlink");
  expect((await readImageFile(real, id)).toString()).toBe("via-symlink");
});

test("a symlinked entry escaping the image directory is not treated as contained", async () => {
  // Regression guard for the realpath-normalized check: a directory name
  // that merely starts with the real dir's path as a string prefix, but
  // is actually a sibling, must not be treated as "inside" it.
  const dir = await freshDir();
  const siblingWithPrefixName = `${dir}-evil`;
  await mkdir(siblingWithPrefixName, { recursive: true });

  const id = "44444444-4444-4444-4444-444444444444";
  await writeImageFile(dir, id, Buffer.from("real"));

  // A naive string-prefix check on `siblingWithPrefixName` could wrongly
  // treat it as inside `dir` (since it starts with the same string) --
  // the sibling directory only ever has its own file, never `dir`'s.
  await expect(readImageFile(siblingWithPrefixName, id)).rejects.toThrow();
});
