import { useCallback, useEffect, useRef, useState } from "react";
import { hubClient as defaultHubClient } from "@/lib/hub-client-instance";
import {
  HubClientError,
  type ChatAttachment,
  type ChatMessage,
  type Conversation,
  type HubClient,
  type ProviderModel,
} from "@/lib/hub-client";
import {
  createAttachmentId,
  fileToDataUrl,
  filesFromFileList,
  validate as validateAttachment,
  type Attachment,
} from "@/lib/attachments";
import { ComposerAttachments } from "@/components/composer-attachments";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/field";
import { Link } from "@/components/ui/link";
import { Loader } from "@/components/ui/loader";
import { PlusIcon, SendIcon, TrashIcon, IconPaperclip, ChatBubbleLeftIcon } from "@/components/icons/lucide";
import { getErrorMessage } from "@/lib/error-message";

interface ChatViewProps {
  client?: HubClient;
}

// Same literal error codes chatRoutes sends (apps/hub/src/chat/routes.ts) as
// the images/provider surface -- chat shares the "images_disabled" gate
// (both features fail the same way when MANDO_ENCRYPTION_KEY is unset), and
// "provider_not_configured" is returned synchronously from POST .../messages
// before any SSE streaming starts.
const PROVIDER_NOT_CONFIGURED = "provider_not_configured";
const CHAT_DISABLED_MESSAGE =
  "Chat is disabled on this hub -- ask an administrator to configure MANDO_ENCRYPTION_KEY.";

// Same chat-capability filter as provider-settings.tsx's isChatCapableModelId
// (per the plan's Task 4 filter list) -- duplicated rather than shared,
// since the two call sites are the only ones and the filter is a few lines.
const NON_CHAT_SUBSTRINGS = ["embedding", "whisper", "kokoro", "rerank"];

function isChatCapableModelId(id: string): boolean {
  const lower = id.toLowerCase();
  if (lower.startsWith("flux")) return false;
  return !NON_CHAT_SUBSTRINGS.some((needle) => lower.includes(needle));
}

function isProviderNotConfigured(err: unknown): boolean {
  return err instanceof HubClientError && err.status === 400 && err.message === PROVIDER_NOT_CONFIGURED;
}

function isChatDisabled(err: unknown): boolean {
  return err instanceof HubClientError && err.status === 503;
}

type Notice = { kind: "provider" | "error"; message: string };

function noticeFromError(err: unknown, fallback: string): Notice {
  if (isProviderNotConfigured(err)) {
    return { kind: "provider", message: "Set up a provider in Settings first." };
  }
  if (isChatDisabled(err)) {
    return { kind: "error", message: CHAT_DISABLED_MESSAGE };
  }
  return { kind: "error", message: getErrorMessage(err) ?? fallback };
}

function NoticeBanner({ notice }: { notice: Notice }) {
  if (notice.kind === "provider") {
    return (
      <div role="alert" className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-fg">
        {notice.message} <Link href="/settings">Go to Settings</Link>
      </div>
    );
  }
  return (
    <div role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
      {notice.message}
    </div>
  );
}

// Maps chatRoutes' SSE "error" event data (chat/provider-client.ts's
// ChatProviderErrorReason) to a sentence -- never the provider's raw error
// text, which the hub never forwards here in the first place.
function describeStreamErrorReason(reason: string): string {
  switch (reason) {
    case "unsafe_url":
      return "The configured provider URL is not allowed.";
    case "too_large":
      return "The provider's reply was too long and got cut off.";
    case "invalid_response":
      return "The provider sent back a response that could not be read.";
    case "request_failed":
    default:
      return "Could not reach the configured provider.";
  }
}

// Local view of a message that also covers the two states a real,
// persisted ChatMessage never has: still streaming in, or failed mid-stream.
// Both are transient/optimistic -- neither survives a reload, matching what
// the hub actually persisted (see chat/routes.ts: an errored stream never
// appends an assistant row).
type DisplayMessage = ChatMessage & { pending?: boolean; errorReason?: string };

type ConversationsState =
  | { status: "loading" }
  | { status: "ready"; conversations: Conversation[] }
  | { status: "disabled" }
  | { status: "error"; message: string };

type ThreadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; messages: DisplayMessage[] }
  | { status: "error"; message: string };

type ModelsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; ids: string[] }
  | { status: "error" };

function MessageBubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === "user";
  const isEmptyPending = message.pending && message.content.length === 0 && !message.errorReason;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        data-testid={`message-${message.role}`}
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser ? "bg-primary text-primary-fg" : "bg-muted/40 text-fg"
        }`}
      >
        {message.attachments && message.attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {message.attachments.map((attachment, index) => (
              <img
                key={`${message.id}-${index}`}
                src={attachment.dataUrl}
                alt={attachment.name ?? "Attached image"}
                className="size-16 rounded object-cover"
              />
            ))}
          </div>
        )}
        {message.errorReason ? (
          <div role="alert" className="text-danger-subtle-fg">
            {describeStreamErrorReason(message.errorReason)}
          </div>
        ) : isEmptyPending ? (
          <Loader className="size-4" aria-label="Waiting for reply" />
        ) : (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        )}
      </div>
    </div>
  );
}

// Standalone "Chat" section: create/select/delete conversations and send
// messages with a live-streamed assistant reply, through the user's own
// provider (configured on the Settings page). User-scoped and independent
// of any paired machine -- this component never touches useMachineStore or
// an opencode proxy (see docs/superpowers/plans/2026-07-05-chat-and-images-v2.md,
// Task 5b).
export function ChatView({ client = defaultHubClient }: ChatViewProps) {
  const [conversationsState, setConversationsState] = useState<ConversationsState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadState>({ status: "idle" });
  const [modelsState, setModelsState] = useState<ModelsState>({ status: "idle" });
  const [newModel, setNewModel] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const attachmentsRef = useRef<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function loadConversations() {
    setConversationsState({ status: "loading" });
    try {
      const conversations = await client.listConversations();
      setConversationsState({ status: "ready", conversations });
    } catch (err) {
      if (isChatDisabled(err)) {
        setConversationsState({ status: "disabled" });
      } else {
        setConversationsState({
          status: "error",
          message: getErrorMessage(err) ?? "Failed to load conversations.",
        });
      }
    }
  }

  async function loadModels() {
    setModelsState({ status: "loading" });
    try {
      const models = await client.listProviderModels();
      const ids = models.map((model: ProviderModel) => model.id).filter(isChatCapableModelId);
      setModelsState({ status: "ready", ids });
    } catch {
      // No provider configured yet, provider unreachable, SSRF-guard
      // rejection, etc. -- the picker is a convenience only; a new
      // conversation can still be created without a model (the hub falls
      // back to the provider's configured chat model).
      setModelsState({ status: "error" });
    }
  }

  useEffect(() => {
    loadConversations();
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    if (!selectedId) {
      setThread({ status: "idle" });
      return;
    }

    let cancelled = false;
    setThread({ status: "loading" });
    client
      .getConversation(selectedId)
      .then((result) => {
        if (cancelled) return;
        setThread({ status: "ready", messages: result.messages });
      })
      .catch((err) => {
        if (cancelled) return;
        setThread({ status: "error", message: getErrorMessage(err) ?? "Failed to load conversation." });
      });
    return () => {
      cancelled = true;
    };
  }, [client, selectedId]);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    setNotice(null);
    try {
      const conversation = await client.createConversation(newModel ? { model: newModel } : undefined);
      setConversationsState((current) => ({
        status: "ready",
        conversations: [conversation, ...(current.status === "ready" ? current.conversations : [])],
      }));
      setSelectedId(conversation.id);
    } catch (err) {
      setNotice(noticeFromError(err, "Failed to create conversation."));
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteConversation(id: string) {
    setDeletingId(id);
    try {
      await client.deleteConversation(id);
      setConversationsState((current) =>
        current.status === "ready"
          ? { status: "ready", conversations: current.conversations.filter((c) => c.id !== id) }
          : current,
      );
      setSelectedId((current) => (current === id ? null : current));
    } catch (err) {
      console.error("Failed to delete conversation:", err);
    } finally {
      setDeletingId(null);
    }
  }

  const applyAttachments = useCallback((next: Attachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setAttachmentError(null);

      for (const file of files) {
        // Vision only accepts images -- unlike the session composer, a PDF
        // has nowhere to go once forwarded as an OpenAI `image_url` content
        // part (see chat/routes.ts's toProviderMessages).
        if (!file.type.startsWith("image/")) {
          setAttachmentError("Only images can be attached to a chat message.");
          break;
        }

        const result = validateAttachment(file, attachmentsRef.current);
        if (!result.ok) {
          setAttachmentError(result.error);
          break;
        }

        const pendingId = createAttachmentId();
        applyAttachments([
          ...attachmentsRef.current,
          { id: pendingId, name: file.name, mime: file.type, size: file.size, dataUrl: "" },
        ]);

        try {
          const dataUrl = await fileToDataUrl(file);
          applyAttachments(
            attachmentsRef.current.map((attachment) =>
              attachment.id === pendingId ? { ...attachment, dataUrl } : attachment,
            ),
          );
        } catch {
          setAttachmentError("Failed to read file.");
          applyAttachments(attachmentsRef.current.filter((attachment) => attachment.id !== pendingId));
        }
      }
    },
    [applyAttachments],
  );

  function removeAttachment(id: string) {
    applyAttachments(attachmentsRef.current.filter((attachment) => attachment.id !== id));
  }

  const hasPendingAttachmentReads = attachments.some((attachment) => attachment.dataUrl === "");

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    const conversationId = selectedId;
    if (!conversationId || sending || hasPendingAttachmentReads) return;

    const trimmed = input.trim();
    if (!trimmed && attachments.length === 0) return;

    const chatAttachments: ChatAttachment[] = attachments.map((attachment) => ({
      mime: attachment.mime,
      dataUrl: attachment.dataUrl,
      name: attachment.name,
    }));

    const now = new Date().toISOString();
    const userMessageId = `pending-user-${createAttachmentId()}`;
    const assistantMessageId = `pending-assistant-${createAttachmentId()}`;

    const userMessage: DisplayMessage = {
      id: userMessageId,
      role: "user",
      content: trimmed,
      attachments: chatAttachments.length > 0 ? chatAttachments : null,
      createdAt: now,
    };
    const assistantPlaceholder: DisplayMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      attachments: null,
      createdAt: now,
      pending: true,
    };

    setThread((current) =>
      current.status === "ready"
        ? { status: "ready", messages: [...current.messages, userMessage, assistantPlaceholder] }
        : current,
    );
    setInput("");
    applyAttachments([]);
    setAttachmentError(null);
    setNotice(null);
    setSending(true);

    function updateAssistant(patch: Partial<DisplayMessage>) {
      setThread((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              messages: current.messages.map((message) =>
                message.id === assistantMessageId ? { ...message, ...patch } : message,
              ),
            }
          : current,
      );
    }

    try {
      await client.streamMessage(
        conversationId,
        { content: trimmed, attachments: chatAttachments.length > 0 ? chatAttachments : undefined },
        (delta) => {
          setThread((current) =>
            current.status === "ready"
              ? {
                  status: "ready",
                  messages: current.messages.map((message) =>
                    message.id === assistantMessageId
                      ? { ...message, content: message.content + delta }
                      : message,
                  ),
                }
              : current,
          );
        },
        (reason) => {
          updateAssistant({ pending: false, errorReason: reason });
        },
        (message) => {
          setThread((current) =>
            current.status === "ready"
              ? {
                  status: "ready",
                  messages: current.messages.map((existing) =>
                    existing.id === assistantMessageId ? { ...message, pending: false } : existing,
                  ),
                }
              : current,
          );
        },
      );
    } catch (err) {
      // Nothing was persisted server-side for a thrown error (chatRoutes
      // returns 400/404/429/503 before ever calling streamSSE) -- roll back
      // both optimistic bubbles rather than leaving them looking sent.
      setThread((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              messages: current.messages.filter(
                (message) => message.id !== userMessageId && message.id !== assistantMessageId,
              ),
            }
          : current,
      );
      setNotice(noticeFromError(err, "Failed to send message."));
    } finally {
      setSending(false);
    }
  }

  const conversations = conversationsState.status === "ready" ? conversationsState.conversations : [];
  const canSend = Boolean(input.trim() || attachments.length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {notice && <NoticeBanner notice={notice} />}
      <div className="flex min-h-0 flex-1 gap-4">
        <aside className="flex w-64 shrink-0 flex-col gap-3 border-r border-border pr-4">
          <h2 className="text-sm font-medium">Conversations</h2>

          <div className="space-y-2">
            {modelsState.status === "ready" && (
              <div className="space-y-1">
                <Label htmlFor="chat-new-model">Model</Label>
                <select
                  id="chat-new-model"
                  aria-label="Model"
                  className="w-full rounded-lg border border-input bg-transparent px-3 py-1.5 text-sm"
                  value={newModel}
                  onChange={(event) => setNewModel(event.target.value)}
                >
                  <option value="">Provider default</option>
                  {modelsState.ids.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <Button type="button" onPress={handleCreate} isDisabled={creating} className="w-full">
              <PlusIcon className="size-4" data-slot="icon" />
              {creating ? "Creating..." : "New conversation"}
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {conversationsState.status === "loading" && (
              <p className="text-sm text-muted-fg">Loading conversations...</p>
            )}

            {conversationsState.status === "disabled" && (
              <NoticeBanner notice={{ kind: "error", message: CHAT_DISABLED_MESSAGE }} />
            )}

            {conversationsState.status === "error" && (
              <div role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
                {conversationsState.message}
              </div>
            )}

            {conversationsState.status === "ready" && conversations.length === 0 && (
              <p className="text-sm text-muted-fg">No conversations yet. Start one above.</p>
            )}

            {conversationsState.status === "ready" && conversations.length > 0 && (
              <ul className="space-y-1">
                {conversations.map((conversation) => (
                  <li key={conversation.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setSelectedId(conversation.id)}
                      aria-current={selectedId === conversation.id}
                      className={`min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm ${
                        selectedId === conversation.id ? "bg-muted/60 text-fg" : "text-muted-fg hover:bg-muted/30"
                      }`}
                    >
                      {conversation.title ?? "Untitled conversation"}
                    </button>
                    <Button
                      type="button"
                      size="sq-xs"
                      intent="plain"
                      aria-label={`Delete conversation: ${conversation.title ?? conversation.id}`}
                      onPress={() => handleDeleteConversation(conversation.id)}
                      isDisabled={deletingId === conversation.id}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100"
                    >
                      <TrashIcon className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {!selectedId && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-fg">
              <ChatBubbleLeftIcon className="size-8" />
              <p className="text-sm">Select a conversation, or start a new one to begin chatting.</p>
            </div>
          )}

          {selectedId && (
            <>
              <div className="flex-1 space-y-3 overflow-y-auto pb-3">
                {thread.status === "loading" && <p className="text-sm text-muted-fg">Loading messages...</p>}

                {thread.status === "error" && (
                  <div role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
                    {thread.message}
                  </div>
                )}

                {thread.status === "ready" && thread.messages.length === 0 && (
                  <p className="text-sm text-muted-fg">Send a message to start the conversation.</p>
                )}

                {thread.status === "ready" &&
                  thread.messages.map((message) => <MessageBubble key={message.id} message={message} />)}
              </div>

              <form onSubmit={handleSend} aria-label="Send a chat message" className="border-t border-border pt-3">
                {attachmentError && (
                  <div
                    role="alert"
                    className="mb-3 rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg"
                  >
                    {attachmentError}
                  </div>
                )}
                <ComposerAttachments attachments={attachments} onRemove={removeAttachment} disabled={sending} />
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*"
                  hidden
                  onChange={(event) => {
                    void addFiles(filesFromFileList(event.target.files));
                    event.target.value = "";
                  }}
                />
                <div className="relative">
                  <Textarea
                    aria-label="Message"
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        if (canSend && !sending && !hasPendingAttachmentReads) {
                          handleSend(event as unknown as React.FormEvent);
                        }
                      }
                    }}
                    placeholder="Message..."
                    className="min-h-24 w-full resize-none pr-14"
                  />
                  <Button
                    type="submit"
                    isCircle
                    size="sq-sm"
                    aria-label={sending ? "Sending message" : "Send message"}
                    isDisabled={!canSend || sending || hasPendingAttachmentReads}
                    className="absolute right-3 bottom-3"
                  >
                    {sending ? <Loader className="size-4" aria-label="Sending message" /> : <SendIcon size="16px" />}
                  </Button>
                </div>
                <div className="mt-2">
                  <Button
                    type="button"
                    intent="plain"
                    size="sq-sm"
                    aria-label="Attach image"
                    isDisabled={sending}
                    onPress={() => fileInputRef.current?.click()}
                  >
                    <IconPaperclip size="16px" />
                  </Button>
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
