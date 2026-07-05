import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { deleteImageFile, writeImageFile } from "./storage";

type Sql = ReturnType<typeof postgres>;

export type ImageMetadata = {
  id: string;
  user_id: string;
  prompt: string | null;
  mime: string;
  size_bytes: number;
  source_kind: string | null;
  created_at: Date | string;
};

// The DB's file_path column, per row -- always the same value as `id`
// (see createImage: storage.ts names files by id alone, so there is no
// separate naming scheme to track). Kept as its own column rather than
// reusing `id` directly so a future naming scheme (sharded directories,
// extensions, etc.) doesn't require a data migration to introduce.
export type ImageFileRef = { id: string; user_id: string; mime: string; file_path: string };

// Writes the file to disk FIRST, with a freshly minted server-side UUID,
// THEN inserts the DB row using that same id/file_path -- so a crash
// between the two steps leaks an orphaned file (disk waste, cleaned up by
// a future startup sweep, documented as a non-blocking follow-up) rather
// than an orphaned DB row pointing at a file that was never written. The
// reverse ordering (insert first) would risk :id/raw serving a 404-worthy
// "row exists, file missing" state, which is the worse failure mode.
export async function createImage(
  sql: Sql,
  imageDir: string,
  userId: string,
  input: { prompt: string | null; mime: string; bytes: Buffer; sourceKind: string | null },
): Promise<ImageMetadata> {
  const id = randomUUID();
  await writeImageFile(imageDir, id, input.bytes);

  const rows = await sql`
    insert into generated_images (id, user_id, prompt, mime, file_path, size_bytes, source_kind)
    values (${id}, ${userId}, ${input.prompt}, ${input.mime}, ${id}, ${input.bytes.length}, ${input.sourceKind})
    returning id, user_id, prompt, mime, size_bytes, source_kind, created_at
  `;
  return rows[0] as ImageMetadata;
}

export async function listMetadata(sql: Sql, userId: string): Promise<ImageMetadata[]> {
  const rows = await sql`
    select id, user_id, prompt, mime, size_bytes, source_kind, created_at
    from generated_images
    where user_id = ${userId}
    order by created_at desc, id desc
  `;
  return rows as unknown as ImageMetadata[];
}

// Owner-scoped by construction -- the query filters on user_id, not just
// id, so a caller can never fetch (or accidentally leak) another user's
// image by guessing/enumerating ids. Returns null both when the id
// doesn't exist at all and when it belongs to someone else, so callers
// (routes.ts) can't distinguish the two and turn that into an enumeration
// oracle. Returns only what's needed to read the file off disk (routes.ts
// calls storage.ts's readImageFile with the returned file_path) -- the
// bytes themselves are never a DB concern anymore.
export async function getFileRef(sql: Sql, id: string, userId: string): Promise<ImageFileRef | null> {
  const rows = await sql`
    select id, user_id, mime, file_path
    from generated_images
    where id = ${id} and user_id = ${userId}
  `;
  return (rows[0] as ImageFileRef) ?? null;
}

// Same owner-scoping as getFileRef: the delete's WHERE clause requires a
// matching user_id, so this can't be used to delete someone else's image.
// Deletes the DB row BEFORE unlinking the file (DB-delete-before-unlink,
// same ordering as retainImages below) so a crash after the DB delete
// leaks a file rather than leaving a row that points at nothing. Unlink
// failures are logged, not thrown -- the DB delete already succeeded and
// is the source of truth for whether the image was "deleted" from the
// caller's point of view.
export async function deleteImage(sql: Sql, imageDir: string, id: string, userId: string): Promise<boolean> {
  const rows = await sql`
    delete from generated_images where id = ${id} and user_id = ${userId} returning file_path
  `;
  if (rows.length === 0) return false;

  const filePath = rows[0]!.file_path as string;
  await deleteImageFile(imageDir, filePath).catch((err) => {
    console.error(`images: failed to unlink ${filePath} after deleting its row`, err);
  });
  return true;
}

export type RetainImagesOptions = { retentionDays: number; maxPerUser: number };
export type RetainImagesSummary = { deleted: number };

// Scheduled sweep (called from retention.ts on an interval, never from the
// request path): deletes any row that is EITHER older than
// retentionDays OR ranked beyond maxPerUser for its user (newest kept),
// across all users in one query, then unlinks the corresponding files.
// DB-delete-before-unlink, same rationale as deleteImage above: the
// RETURNING clause captures exactly which files to unlink from rows that
// are already gone from the DB, so a crash mid-sweep can only leak files,
// never leave an orphaned row.
export async function retainImages(sql: Sql, imageDir: string, opts: RetainImagesOptions): Promise<RetainImagesSummary> {
  const cutoff = new Date(Date.now() - opts.retentionDays * 24 * 60 * 60 * 1000);

  const rows = await sql`
    delete from generated_images
    where created_at < ${cutoff}
       or id in (
         select id from (
           select id, row_number() over (partition by user_id order by created_at desc, id desc) as rn
           from generated_images
         ) ranked
         where rn > ${opts.maxPerUser}
       )
    returning file_path
  `;

  for (const row of rows) {
    const filePath = row.file_path as string;
    await deleteImageFile(imageDir, filePath).catch((err) => {
      console.error(`images retention: failed to unlink ${filePath} after deleting its row`, err);
    });
  }

  return { deleted: rows.length };
}
