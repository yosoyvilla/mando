-- v1.5 standalone Chat surface (Task 5a of the chat-and-images-v2 plan):
-- a conversation belongs to exactly one user (cascade-deleted with them,
-- same ownership shape as generated_images/user_provider_settings), and
-- holds an ordered list of messages. attachments is jsonb rather than a
-- separate table since it is always a small, denormalized array read/written
-- as a unit alongside its message, never queried independently.
create table if not exists chat_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  title text,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references chat_conversations(id) on delete cascade,
  role text not null,
  content text not null,
  attachments jsonb,
  created_at timestamptz not null default now()
);

-- Backs listConversations' per-user, most-recently-updated ordering
-- (chat/repo.ts).
create index if not exists chat_conversations_user_id_updated_at_idx
  on chat_conversations (user_id, updated_at desc);

-- Backs getConversation's per-conversation, chronological message replay
-- (chat/repo.ts).
create index if not exists chat_messages_conversation_id_created_at_idx
  on chat_messages (conversation_id, created_at asc);
