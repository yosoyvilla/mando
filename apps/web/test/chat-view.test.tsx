import { describe, it, expect, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChatView } from "../src/components/chat-view";
import {
  HubClientError,
  type ChatMessage,
  type Conversation,
  type ConversationWithMessages,
  type HubClient,
} from "../src/lib/hub-client";

function stubClient(overrides: Partial<HubClient> = {}): HubClient {
  return {
    login: mock(() => Promise.reject(new Error("not implemented"))),
    logout: mock(() => Promise.reject(new Error("not implemented"))),
    me: mock(() => Promise.reject(new Error("not implemented"))),
    createUser: mock(() => Promise.reject(new Error("not implemented"))),
    listUsers: mock(() => Promise.reject(new Error("not implemented"))),
    adminDeleteUser: mock(() => Promise.reject(new Error("not implemented"))),
    listMachines: mock(() => Promise.reject(new Error("not implemented"))),
    getMachine: mock(() => Promise.reject(new Error("not implemented"))),
    revokeMachine: mock(() => Promise.reject(new Error("not implemented"))),
    approvePairing: mock(() => Promise.reject(new Error("not implemented"))),
    opencode: mock(() => {
      throw new Error("not implemented");
    }),
    getProvider: mock(() => Promise.reject(new Error("not implemented"))),
    setProvider: mock(() => Promise.reject(new Error("not implemented"))),
    deleteProvider: mock(() => Promise.reject(new Error("not implemented"))),
    listProviderModels: mock(() => Promise.resolve([])),
    generateImage: mock(() => Promise.reject(new Error("not implemented"))),
    editImage: mock(() => Promise.reject(new Error("not implemented"))),
    listImages: mock(() => Promise.reject(new Error("not implemented"))),
    imageRawUrl: mock((id: string) => `/api/v1/images/${id}/raw`),
    deleteImage: mock(() => Promise.reject(new Error("not implemented"))),
    listConversations: mock(() => Promise.resolve([])),
    createConversation: mock(() => Promise.reject(new Error("not implemented"))),
    getConversation: mock(() => Promise.reject(new Error("not implemented"))),
    deleteConversation: mock(() => Promise.reject(new Error("not implemented"))),
    streamMessage: mock(() => Promise.reject(new Error("not implemented"))),
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv1",
    title: "First conversation",
    model: null,
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    role: "user",
    content: "hello",
    attachments: null,
    createdAt: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("ChatView", () => {
  it("shows an empty state when there are no conversations yet", async () => {
    render(<ChatView client={stubClient()} />);
    await waitFor(() => {
      expect(screen.getByText(/No conversations yet/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Select a conversation/)).toBeInTheDocument();
  });

  it("renders the conversation list and loads a selected conversation's messages", async () => {
    const conv = conversation();
    const detail: ConversationWithMessages = {
      ...conv,
      messages: [message({ id: "m1", role: "user", content: "hi there" })],
    };
    const client = stubClient({
      listConversations: mock(() => Promise.resolve([conv])),
      getConversation: mock(() => Promise.resolve(detail)),
    });
    render(<ChatView client={client} />);

    const item = await screen.findByText("First conversation");
    fireEvent.click(item);

    await waitFor(() => {
      expect(client.getConversation).toHaveBeenCalledWith("conv1");
    });
    expect(await screen.findByText("hi there")).toBeInTheDocument();
  });

  it("shows a friendly 'set up a provider in Settings first' message when creating a conversation 400s with provider_not_configured", async () => {
    const client = stubClient({
      createConversation: mock(() => Promise.reject(new HubClientError("provider_not_configured", 400))),
    });
    render(<ChatView client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "New conversation" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Set up a provider in Settings first.");
    });
    expect(screen.getByRole("link", { name: /Go to Settings/ })).toHaveAttribute("href", "/settings");
  });

  it("creates a conversation, selects it, and deletes it", async () => {
    const created = conversation({ id: "conv2", title: "Fresh chat" });
    const client = stubClient({
      createConversation: mock(() => Promise.resolve(created)),
      getConversation: mock(() => Promise.resolve({ ...created, messages: [] })),
      deleteConversation: mock(() => Promise.resolve()),
    });
    render(<ChatView client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "New conversation" }));
    await waitFor(() => expect(client.createConversation).toHaveBeenCalledTimes(1));
    await screen.findByText("Send a message to start the conversation.");

    const deleteButton = await screen.findByRole("button", { name: /Delete conversation/ });
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(client.deleteConversation).toHaveBeenCalledWith("conv2");
    });
    await waitFor(() => {
      expect(screen.queryByText("Fresh chat")).toBeNull();
    });
  });

  it("renders a model picker populated from listProviderModels, chat-filtered", async () => {
    const client = stubClient({
      listProviderModels: mock(() =>
        Promise.resolve([{ id: "gpt-4o-mini" }, { id: "text-embedding-3-small" }, { id: "flux-2-klein" }]),
      ),
    });
    render(<ChatView client={client} />);

    const picker = (await screen.findByLabelText("Model")) as HTMLSelectElement;
    const optionValues = Array.from(picker.options).map((o) => o.value).filter(Boolean);
    expect(optionValues).toEqual(["gpt-4o-mini"]);
  });

  it("streams an assistant reply, rendering delta chunks as they arrive", async () => {
    const conv = conversation();
    const client = stubClient({
      listConversations: mock(() => Promise.resolve([conv])),
      getConversation: mock(() => Promise.resolve({ ...conv, messages: [] })),
      streamMessage: mock(async (_id, _input, onDelta, _onError, onDone) => {
        onDelta("Hel");
        onDelta("lo!");
        onDone(message({ id: "a1", role: "assistant", content: "Hello!" }));
      }),
    });
    render(<ChatView client={client} />);

    fireEvent.click(await screen.findByText("First conversation"));
    await screen.findByText("Send a message to start the conversation.");

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "say hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("say hi")).toBeInTheDocument();
    expect(await screen.findByText("Hello!")).toBeInTheDocument();
    expect(client.streamMessage).toHaveBeenCalledWith(
      "conv1",
      { content: "say hi", attachments: undefined },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("shows an inline error bubble when the stream emits a mid-stream error event", async () => {
    const conv = conversation();
    const client = stubClient({
      listConversations: mock(() => Promise.resolve([conv])),
      getConversation: mock(() => Promise.resolve({ ...conv, messages: [] })),
      streamMessage: mock(async (_id, _input, _onDelta, onError) => {
        onError("unsafe_url");
      }),
    });
    render(<ChatView client={client} />);

    fireEvent.click(await screen.findByText("First conversation"));
    await screen.findByText("Send a message to start the conversation.");

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "say hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(screen.getByText("The configured provider URL is not allowed.")).toBeInTheDocument();
    });
  });

  it("attaches an image and includes it in the streamed message", async () => {
    const conv = conversation();
    const client = stubClient({
      listConversations: mock(() => Promise.resolve([conv])),
      getConversation: mock(() => Promise.resolve({ ...conv, messages: [] })),
      streamMessage: mock(async (_id, _input, _onDelta, _onError, onDone) => {
        onDone(message({ id: "a1", role: "assistant", content: "nice picture" }));
      }),
    });
    render(<ChatView client={client} />);

    fireEvent.click(await screen.findByText("First conversation"));
    await screen.findByText("Send a message to start the conversation.");

    const file = new File([new Uint8Array([1, 2, 3])], "cat.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    // The attached file is read into a data URL asynchronously (FileReader)
    // -- wait for that read to resolve (the chip's <img src> becomes a real
    // data URL) before doing anything else, rather than racing further
    // input against it.
    await waitFor(() => {
      const chipImage = document.querySelector('[data-testid="composer-attachments"] img');
      expect(chipImage?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    });

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "what is this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(client.streamMessage).toHaveBeenCalledWith(
        "conv1",
        {
          content: "what is this",
          attachments: [{ mime: "image/png", dataUrl: expect.any(String), name: "cat.png" }],
        },
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );
    });
  });
});
