import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

export type Conversation = {
  id: string;
  user_id: string;
  title: string | null;
  model: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type Message = {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  attachments: unknown | null;
  created_at: Date | string;
};

export async function listConversations(sql: Sql, userId: string): Promise<Conversation[]> {
  const rows = await sql`
    select * from chat_conversations
    where user_id = ${userId}
    order by updated_at desc, id desc
  `;
  return rows as unknown as Conversation[];
}

export async function createConversation(
  sql: Sql,
  userId: string,
  input: { model: string | null; title: string | null },
): Promise<Conversation> {
  const rows = await sql`
    insert into chat_conversations (user_id, title, model)
    values (${userId}, ${input.title}, ${input.model})
    returning *
  `;
  return rows[0] as Conversation;
}

export type ConversationWithMessages = { conversation: Conversation; messages: Message[] };

// Owner-scoped by construction -- the query filters on user_id, not just
// id, so a caller can never fetch (or accidentally leak) another user's
// conversation by guessing/enumerating ids. Returns null both when the id
// doesn't exist at all and when it belongs to someone else, so callers
// (routes.ts) can't distinguish the two and turn that into an enumeration
// oracle -- same shape as images/repo.ts's getFileRef.
export async function getConversation(
  sql: Sql,
  id: string,
  userId: string,
): Promise<ConversationWithMessages | null> {
  const rows = await sql`
    select * from chat_conversations where id = ${id} and user_id = ${userId}
  `;
  const conversation = rows[0] as Conversation | undefined;
  if (!conversation) return null;

  const messages = await sql`
    select * from chat_messages where conversation_id = ${id} order by created_at asc, id asc
  `;
  return { conversation, messages: messages as unknown as Message[] };
}

// Same owner-scoping as getConversation: the delete's WHERE clause requires
// a matching user_id, so this can't be used to delete someone else's
// conversation. chat_messages cascade-deletes with the conversation
// (migrations/009_add_chat.sql), so there is nothing else to clean up here.
export async function deleteConversation(sql: Sql, id: string, userId: string): Promise<boolean> {
  const rows = await sql`
    delete from chat_conversations where id = ${id} and user_id = ${userId} returning id
  `;
  return rows.length > 0;
}

// Not owner-scoped on its own -- callers (routes.ts) only ever reach this
// after already resolving the conversation via the owner-scoped
// getConversation, so re-checking ownership here would just repeat that
// query for no added safety. Bumps the parent conversation's updated_at on
// every call (user message and assistant reply alike), so "most recently
// updated" ordering (listConversations) reflects the latest activity.
export async function appendMessage(
  sql: Sql,
  conversationId: string,
  input: { role: string; content: string; attachments?: unknown },
): Promise<Message> {
  // sql.json(...) (rather than a pre-stringified JSON.stringify string)
  // tags this parameter with the jsonb OID directly, which is also what
  // makes postgres.js decode the column back into a parsed object/array on
  // every subsequent select -- a plain string parameter round-trips as a
  // stored jsonb value but reads back as text, not a parsed value.
  const rows = await sql`
    insert into chat_messages (conversation_id, role, content, attachments)
    values (
      ${conversationId},
      ${input.role},
      ${input.content},
      ${
        // postgres.js's own JSONValue type is a strict recursive union that
        // `unknown` can never satisfy structurally -- the actual runtime
        // value is always caller-supplied, already-serializable data (an
        // attachments array or nothing), so this narrow cast is safe.
        input.attachments != null ? sql.json(input.attachments as postgres.JSONValue) : null
      }
    )
    returning *
  `;
  await sql`update chat_conversations set updated_at = now() where id = ${conversationId}`;
  return rows[0] as Message;
}
