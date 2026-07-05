import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

export type ProviderSettings = {
  user_id: string;
  base_url: string;
  api_key_encrypted: string;
  image_model: string | null;
  chat_model: string | null;
  updated_at: Date | string;
};

export async function getProviderSettings(sql: Sql, userId: string): Promise<ProviderSettings | null> {
  const rows = await sql`select * from user_provider_settings where user_id = ${userId}`;
  return (rows[0] as ProviderSettings) ?? null;
}

// One row per user (user_id is the primary key), so "set" is always an
// upsert -- there is no separate create vs. update distinction for a
// caller to get wrong. api_key_encrypted is expected to already be the
// output of crypto/secretbox.ts's encryptSecret; this layer never sees or
// handles a plaintext key.
export async function upsertProviderSettings(
  sql: Sql,
  userId: string,
  input: { baseUrl: string; apiKeyEncrypted: string; imageModel: string | null; chatModel: string | null },
): Promise<ProviderSettings> {
  const rows = await sql`
    insert into user_provider_settings (user_id, base_url, api_key_encrypted, image_model, chat_model, updated_at)
    values (${userId}, ${input.baseUrl}, ${input.apiKeyEncrypted}, ${input.imageModel}, ${input.chatModel}, now())
    on conflict (user_id) do update set
      base_url = excluded.base_url,
      api_key_encrypted = excluded.api_key_encrypted,
      image_model = excluded.image_model,
      chat_model = excluded.chat_model,
      updated_at = now()
    returning *
  `;
  return rows[0] as ProviderSettings;
}

// Returns whether a row was actually deleted, matching users/repo.ts's
// deleteUser -- lets routes.ts decide whether "nothing configured" should
// still report success (idempotent delete) rather than caring here.
export async function deleteProviderSettings(sql: Sql, userId: string): Promise<boolean> {
  const rows = await sql`delete from user_provider_settings where user_id = ${userId} returning user_id`;
  return rows.length > 0;
}
