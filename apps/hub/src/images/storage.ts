import { mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

// Every image on disk is named by this pattern: a plain, server-generated
// UUID with no path separators, extension, or other characters -- never
// derived from user input (see images/repo.ts's createImage, the only
// caller that mints ids). This regex is enforced on every call below as
// defense-in-depth, not because callers are expected to ever pass
// anything else.
const ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class ImagePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImagePathError";
  }
}

// Creates `dir` (and any missing parents) if it doesn't exist yet.
// Idempotent -- safe to call on every write, not just once at startup, so
// storage.ts never depends on a separate init step running first.
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

// Resolves `id` to an absolute path under `dir`, verified by comparing
// realpath-normalized strings rather than a naive string prefix check --
// so a symlink swapped into `dir` (or one of its ancestors) after mkdir
// can't make the resolved path land outside `dir` without this catching
// it. `id` is additionally validated against ID_RE first: a bare UUID has
// no path separators or ".." segments, so it cannot itself introduce
// traversal, but validating it explicitly keeps that guarantee from
// resting solely on "callers always pass a UUID".
async function resolveWithinDir(dir: string, id: string): Promise<string> {
  if (!ID_RE.test(id)) {
    throw new ImagePathError(`invalid image id: ${id}`);
  }
  await ensureDir(dir);
  const realDir = await realpath(dir);
  const target = join(realDir, id);
  if (target !== realDir + sep + id) {
    throw new ImagePathError("resolved image path escaped the image directory");
  }
  return target;
}

// Writes `bytes` under `dir/id`, creating `dir` if needed. Mode 0o600
// (owner read/write only) -- these bytes came from a user-configured
// third-party provider and are served back only to their owner, so the
// file itself is never meant to be group/world readable on disk.
export async function writeImageFile(dir: string, id: string, bytes: Buffer): Promise<void> {
  const path = await resolveWithinDir(dir, id);
  await writeFile(path, bytes, { mode: 0o600 });
}

export async function readImageFile(dir: string, id: string): Promise<Buffer> {
  const path = await resolveWithinDir(dir, id);
  return readFile(path);
}

// Deleting an already-missing file is treated as success, not an error --
// callers (images/repo.ts's retention sweep and deleteImage) delete the DB
// row first and the file second, so "the file is already gone" is an
// expected, non-exceptional outcome of that ordering (e.g. a retried sweep
// after a partial failure), not a bug to surface.
export async function deleteImageFile(dir: string, id: string): Promise<void> {
  const path = await resolveWithinDir(dir, id);
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
