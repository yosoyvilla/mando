create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event_type text not null,
  actor_user_id uuid references users(id) on delete set null,
  target text,
  ip text,
  metadata jsonb
);
create index if not exists audit_log_created_at_idx on audit_log (created_at);
create index if not exists audit_log_actor_user_id_idx on audit_log (actor_user_id);
