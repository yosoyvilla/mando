import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

// Retention cap enforced per-user after every insert (see insertImage) --
// this bounds per-user storage regardless of how many images a user
// generates over time, without needing a separate scheduled sweep (unlike
// retention.ts's session/audit-log sweep, which runs on a timer because
// nothing else triggers it as naturally as "a new row just landed").
const RETENTION_LIMIT = 50;

export type ImageMetadata = {
  id: string;
  user_id: string;
  prompt: string | null;
  mime: string;
  source_kind: string | null;
  created_at: Date | string;
};

export type ImageRow = ImageMetadata & { bytes: Buffer };

// Inserts one generated image, then trims the user's rows down to the
// newest RETENTION_LIMIT (deleting anything older) in the same call so no
// caller can insert without the retention sweep also running -- there is
// no separate "insert" vs "insert and retain" entry point to get wrong.
export async function insertImage(
  sql: Sql,
  userId: string,
  input: { prompt: string | null; mime: string; bytes: Buffer; sourceKind: string | null },
): Promise<ImageMetadata> {
  const rows = await sql`
    insert into generated_images (user_id, prompt, mime, bytes, source_kind)
    values (${userId}, ${input.prompt}, ${input.mime}, ${input.bytes}, ${input.sourceKind})
    returning id, user_id, prompt, mime, source_kind, created_at
  `;

  await sql`
    delete from generated_images
    where user_id = ${userId}
      and id not in (
        select id from generated_images
        where user_id = ${userId}
        order by created_at desc, id desc
        limit ${RETENTION_LIMIT}
      )
  `;

  return rows[0] as ImageMetadata;
}

export async function listMetadata(sql: Sql, userId: string): Promise<ImageMetadata[]> {
  const rows = await sql`
    select id, user_id, prompt, mime, source_kind, created_at
    from generated_images
    where user_id = ${userId}
    order by created_at desc, id desc
  `;
  return rows as unknown as ImageMetadata[];
}

// Owner-scoped by construction -- the query filters on user_id, not just
// id, so a caller can never fetch (or accidentally leak) another user's
// image bytes by guessing/enumerating ids. Returns null both when the id
// doesn't exist at all and when it belongs to someone else, so callers
// (routes.ts) can't distinguish the two and turn that into an enumeration
// oracle.
export async function getRaw(sql: Sql, id: string, userId: string): Promise<ImageRow | null> {
  const rows = await sql`
    select id, user_id, prompt, mime, bytes, source_kind, created_at
    from generated_images
    where id = ${id} and user_id = ${userId}
  `;
  return (rows[0] as ImageRow) ?? null;
}

// Same owner-scoping as getRaw: the delete's WHERE clause requires a
// matching user_id, so this can't be used to delete someone else's image.
export async function deleteImage(sql: Sql, id: string, userId: string): Promise<boolean> {
  const rows = await sql`
    delete from generated_images where id = ${id} and user_id = ${userId} returning id
  `;
  return rows.length > 0;
}
