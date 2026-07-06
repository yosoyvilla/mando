import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type postgres from "postgres";
import type { Config } from "../config";
import { requireUser, type AuthVariables } from "../auth/middleware";
import { decryptSecret, isEncryptionConfigured } from "../crypto/secretbox";
import { getProviderSettings } from "../providers/repo";
import {
  appendMessage,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  type Conversation,
  type ConversationWithMessages,
  type Message,
} from "./repo";
import { ChatProviderError, streamChat, type ChatClientDeps, type ChatMessageInput } from "./provider-client";

type Sql = ReturnType<typeof postgres>;

// Bounds the message text itself (same "bound the text, separately from
// the bytes" shape as images/routes.ts's MAX_PROMPT_LENGTH).
const MAX_CONTENT_LENGTH = 8_000;
const MAX_TITLE_LENGTH = 200;

// Attachment caps mirror the web composer's own limits (apps/web/src/lib/
// attachments.ts's MAX_ATTACHMENT_FILES / MAX_ATTACHMENT_TOTAL_BYTES) --
// the hub enforces the same bound server-side rather than trusting the
// browser to have applied it.
const MAX_ATTACHMENTS_PER_MESSAGE = 4;
const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;

// Body-size cap for POST .../messages, applied by app.ts as a bodyLimit
// middleware -- the request carries MAX_ATTACHMENT_TOTAL_BYTES (8MB) of raw
// attachment bytes as base64 data URLs inside JSON (~4/3 inflation, no
// further escaping since base64's alphabet needs none), so this clears
// that (~10.7MB) with headroom while still being a real, route-specific
// reduction from app.ts's coarse global MAX_REQUEST_BODY_BYTES. The actual
// 8MB attachment cap is enforced after parsing, in the route handler below.
export const MAX_MESSAGE_BODY_BYTES = 12 * 1024 * 1024;

const createConversationSchema = z.object({
  model: z.string().min(1).max(200).nullable().optional(),
  title: z.string().min(1).max(MAX_TITLE_LENGTH).nullable().optional(),
});

const attachmentSchema = z.object({
  mime: z.string().min(1),
  dataUrl: z.string().min(1),
  name: z.string().max(255).optional(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(MAX_CONTENT_LENGTH),
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
});

type StoredAttachment = z.infer<typeof attachmentSchema>;

async function parseJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

// Decodes a `data:<mime>;base64,<payload>` URL into its raw bytes, or null
// if the string isn't shaped like one -- callers treat null the same as any
// other invalid-request input (400), never as "0 bytes".
function decodeDataUrl(dataUrl: string): Buffer | null {
  const match = /^data:[^,]*;base64,([\s\S]*)$/.exec(dataUrl);
  if (!match) return null;
  try {
    return Buffer.from(match[1]!, "base64");
  } catch {
    return null;
  }
}

function toConversationJson(row: Conversation) {
  return { id: row.id, title: row.title, model: row.model, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toMessageJson(row: Message) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    attachments: row.attachments ?? null,
    createdAt: row.created_at,
  };
}

// Builds the OpenAI-shaped message list the provider actually sees from
// stored rows. Only user messages ever carry attachments (assistant replies
// are always persisted as plain text, see the POST /messages handler below),
// so only those get the multi-part [{type:"text"},{type:"image_url"}]
// content array; every other message is sent as a plain string, matching
// the OpenAI-compatible contract verified live for this provider.
function toProviderMessages(rows: Message[]): ChatMessageInput[] {
  return rows.map((row) => {
    const attachments = Array.isArray(row.attachments) ? (row.attachments as StoredAttachment[]) : [];
    if (row.role !== "user" || attachments.length === 0) {
      return { role: row.role as ChatMessageInput["role"], content: row.content };
    }
    return {
      role: "user",
      content: [
        { type: "text", text: row.content },
        ...attachments.map((a) => ({ type: "image_url" as const, image_url: { url: a.dataUrl } })),
      ],
    };
  });
}

// A malformed :id (not a valid uuid) makes Postgres throw a cast error
// rather than returning zero rows -- folding that into the same "not found"
// outcome as a real, owner-mismatched id keeps 404 the only signal a caller
// gets either way (see images/routes.ts's getFileRefSafe for the same
// fold-DB-errors-into-404 pattern).
async function getConversationSafe(sql: Sql, id: string, userId: string): Promise<ConversationWithMessages | null> {
  try {
    return await getConversation(sql, id, userId);
  } catch {
    return null;
  }
}

async function deleteConversationSafe(sql: Sql, id: string, userId: string): Promise<boolean> {
  try {
    return await deleteConversation(sql, id, userId);
  } catch {
    return false;
  }
}

// clientDeps defaults to the real SSRF guard (provider-client.ts) in
// production; buildApp (app.ts) only overrides it in tests that need a real
// local fake streaming provider server, which the real guard correctly
// always rejects (loopback, plain http) -- same "injectable, defaults to
// the real thing" shape as imageRoutes' clientDeps param.
export function chatRoutes(
  sql: Sql,
  config: Config,
  clientDeps: ChatClientDeps = {},
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // Every route here needs to decrypt the stored provider key to send a
  // message, or exists only because the feature as a whole is enabled, so
  // all of them fail the same way (503, not 500 or a confusing empty list)
  // when MANDO_ENCRYPTION_KEY is unset -- same shape, and same error body,
  // as images/routes.ts and providers/routes.ts's equivalent gate.
  app.use("/api/v1/chat", async (c, next) => {
    if (!isEncryptionConfigured(config)) return c.json({ error: "images_disabled" }, 503);
    await next();
  });
  app.use("/api/v1/chat/*", async (c, next) => {
    if (!isEncryptionConfigured(config)) return c.json({ error: "images_disabled" }, 503);
    await next();
  });

  app.get("/api/v1/chat/conversations", requireUser(sql), async (c) => {
    const rows = await listConversations(sql, c.get("userId"));
    return c.json({ conversations: rows.map(toConversationJson) }, 200);
  });

  app.post("/api/v1/chat/conversations", requireUser(sql), async (c) => {
    const parsed = createConversationSchema.safeParse(await parseJsonBody(c));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);

    const conversation = await createConversation(sql, c.get("userId"), {
      model: parsed.data.model ?? null,
      title: parsed.data.title ?? null,
    });
    return c.json(toConversationJson(conversation), 201);
  });

  app.get("/api/v1/chat/conversations/:id", requireUser(sql), async (c) => {
    const result = await getConversationSafe(sql, c.req.param("id"), c.get("userId"));
    if (!result) return c.notFound();
    return c.json({ ...toConversationJson(result.conversation), messages: result.messages.map(toMessageJson) }, 200);
  });

  app.delete("/api/v1/chat/conversations/:id", requireUser(sql), async (c) => {
    const deleted = await deleteConversationSafe(sql, c.req.param("id"), c.get("userId"));
    return c.json({ ok: true, deleted }, 200);
  });

  app.post("/api/v1/chat/conversations/:id/messages", requireUser(sql), async (c) => {
    const userId = c.get("userId");
    const conversationId = c.req.param("id");

    const parsed = sendMessageSchema.safeParse(await parseJsonBody(c));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);

    const existing = await getConversationSafe(sql, conversationId, userId);
    if (!existing) return c.notFound();

    const settings = await getProviderSettings(sql, userId);
    if (!settings) return c.json({ error: "provider_not_configured" }, 400);

    // Decode + size-cap attachments before anything is persisted or sent to
    // the provider -- same "reject before you ever hold/forward the bytes"
    // shape as images/provider-client.ts's IMAGE_MAX_BYTES check.
    const attachments = parsed.data.attachments ?? [];
    let totalBytes = 0;
    for (const attachment of attachments) {
      const bytes = decodeDataUrl(attachment.dataUrl);
      if (!bytes) return c.json({ error: "invalid request" }, 400);
      totalBytes += bytes.length;
    }
    if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
      return c.json({ error: "attachments_too_large" }, 400);
    }

    const apiKey = decryptSecret(settings.api_key_encrypted, config);
    const model = existing.conversation.model ?? settings.chat_model;

    const userMessage = await appendMessage(sql, conversationId, {
      role: "user",
      content: parsed.data.content,
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    const providerMessages = toProviderMessages([...existing.messages, userMessage]);

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "user_message", data: JSON.stringify(toMessageJson(userMessage)) });

      let assistantContent = "";
      try {
        for await (const delta of streamChat(
          { baseUrl: settings.base_url, apiKey, model, messages: providerMessages },
          clientDeps,
        )) {
          if (delta.content) {
            assistantContent += delta.content;
            await stream.writeSSE({ event: "delta", data: delta.content });
          }
        }
      } catch (err) {
        // Never the provider's raw error body and never the API key -- only
        // the short, static reason string provider-client.ts already
        // classified the failure into (see providerErrorResponse above).
        const reason = err instanceof ChatProviderError ? err.reason : "request_failed";
        await stream.writeSSE({ event: "error", data: reason });
        return;
      }

      const assistantMessage = await appendMessage(sql, conversationId, {
        role: "assistant",
        content: assistantContent,
      });
      await stream.writeSSE({ event: "done", data: JSON.stringify(toMessageJson(assistantMessage)) });
    });
  });

  return app;
}
