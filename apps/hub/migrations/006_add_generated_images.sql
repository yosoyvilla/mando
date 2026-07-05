create table if not exists generated_images (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  prompt text,
  mime text not null,
  bytes bytea not null,
  source_kind text,
  created_at timestamptz not null default now()
);

-- Backs both listMetadata's per-user ordering and insertImage's
-- retention sweep (images/repo.ts), which both select the newest N rows
-- for a given user_id ordered by created_at desc.
create index if not exists generated_images_user_id_created_at_idx
  on generated_images (user_id, created_at desc);
