import { describe, it, expect, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProviderSettings } from "../src/components/provider-settings";
import { HubClientError, type HubClient, type Provider } from "../src/lib/hub-client";

function stubClient(overrides: Partial<HubClient> = {}): HubClient {
  return {
    login: mock(() => Promise.reject(new Error("not implemented"))),
    logout: mock(() => Promise.reject(new Error("not implemented"))),
    me: mock(() => Promise.reject(new Error("not implemented"))),
    createUser: mock(() => Promise.reject(new Error("not implemented"))),
    listUsers: mock(() => Promise.reject(new Error("not implemented"))),
    adminDeleteUser: mock(() => Promise.reject(new Error("not implemented"))),
    changePassword: mock(() => Promise.reject(new Error("not implemented"))),
    setUserAdmin: mock(() => Promise.reject(new Error("not implemented"))),
    listMachines: mock(() => Promise.reject(new Error("not implemented"))),
    getMachine: mock(() => Promise.reject(new Error("not implemented"))),
    revokeMachine: mock(() => Promise.reject(new Error("not implemented"))),
    approvePairing: mock(() => Promise.reject(new Error("not implemented"))),
    opencode: mock(() => {
      throw new Error("not implemented");
    }),
    getProvider: mock(() => Promise.resolve({ baseUrl: null, imageModel: null, chatModel: null, hasKey: false })),
    setProvider: mock(() => Promise.resolve()),
    deleteProvider: mock(() => Promise.resolve()),
    listProviderModels: mock(() => Promise.reject(new Error("not implemented"))),
    generateImage: mock(() => Promise.reject(new Error("not implemented"))),
    editImage: mock(() => Promise.reject(new Error("not implemented"))),
    listImages: mock(() => Promise.reject(new Error("not implemented"))),
    imageRawUrl: mock((id: string) => `/api/v1/images/${id}/raw`),
    deleteImage: mock(() => Promise.reject(new Error("not implemented"))),
    listConversations: mock(() => Promise.reject(new Error("not implemented"))),
    createConversation: mock(() => Promise.reject(new Error("not implemented"))),
    getConversation: mock(() => Promise.reject(new Error("not implemented"))),
    deleteConversation: mock(() => Promise.reject(new Error("not implemented"))),
    streamMessage: mock(() => Promise.reject(new Error("not implemented"))),
    ...overrides,
  };
}

describe("ProviderSettings", () => {
  it("loads existing settings and shows the API key as write-only ('configured', never the value)", async () => {
    const provider: Provider = {
      baseUrl: "https://api.example.com/v1",
      imageModel: "flux-2-klein",
      chatModel: "gpt-4o-mini",
      hasKey: true,
    };
    const client = stubClient({
      getProvider: mock(() => Promise.resolve(provider)),
      listProviderModels: mock(() => Promise.resolve([])),
    });

    render(<ProviderSettings client={client} />);

    const baseUrlInput = await screen.findByLabelText("Base URL") as HTMLInputElement;
    expect(baseUrlInput.value).toBe("https://api.example.com/v1");

    const apiKeyInput = screen.getByLabelText("API key") as HTMLInputElement;
    expect(apiKeyInput.value).toBe("");
    expect(apiKeyInput.placeholder).toBe("configured — leave blank to keep");

    const imageModelInput = screen.getByLabelText("Image model") as HTMLInputElement;
    expect(imageModelInput.value).toBe("flux-2-klein");

    const chatModelInput = screen.getByLabelText("Chat model") as HTMLInputElement;
    expect(chatModelInput.value).toBe("gpt-4o-mini");
  });

  it("saves baseUrl and imageModel WITHOUT an apiKey when the field is left blank", async () => {
    const client = stubClient();
    render(<ProviderSettings client={client} />);

    const baseUrlInput = await screen.findByLabelText("Base URL");
    fireEvent.change(baseUrlInput, { target: { value: "https://api.example.com/v1" } });
    fireEvent.change(screen.getByLabelText("Image model"), { target: { value: "flux-2-klein" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(client.setProvider).toHaveBeenCalledWith({
        baseUrl: "https://api.example.com/v1",
        apiKey: undefined,
        imageModel: "flux-2-klein",
        chatModel: null,
      });
    });
  });

  it("sends the entered apiKey when the user types a new one", async () => {
    const client = stubClient();
    render(<ProviderSettings client={client} />);

    const baseUrlInput = await screen.findByLabelText("Base URL");
    fireEvent.change(baseUrlInput, { target: { value: "https://api.example.com/v1" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-newkey" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(client.setProvider).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: "https://api.example.com/v1", apiKey: "sk-newkey" }),
      );
    });
  });

  it("renders the server's validation error (e.g. an unsafe URL) inline", async () => {
    const client = stubClient({
      setProvider: mock(() =>
        Promise.reject(new HubClientError("unsafe provider URL: only https URLs are allowed", 400)),
      ),
    });
    render(<ProviderSettings client={client} />);

    const baseUrlInput = await screen.findByLabelText("Base URL");
    fireEvent.change(baseUrlInput, { target: { value: "http://insecure.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "unsafe provider URL: only https URLs are allowed",
      );
    });
  });

  it("renders a friendly message (not the raw 'images_disabled' code) when the hub has no encryption key configured", async () => {
    const client = stubClient({
      getProvider: mock(() => Promise.reject(new HubClientError("images_disabled", 503))),
    });
    render(<ProviderSettings client={client} />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/MANDO_ENCRYPTION_KEY/);
    });
    expect(screen.queryByText("images_disabled")).toBeNull();
  });

  it("clears the provider settings when Clear is pressed", async () => {
    const provider: Provider = {
      baseUrl: "https://api.example.com/v1",
      imageModel: "flux-2-klein",
      chatModel: "gpt-4o-mini",
      hasKey: true,
    };
    const client = stubClient({
      getProvider: mock(() => Promise.resolve(provider)),
      listProviderModels: mock(() => Promise.resolve([])),
    });
    render(<ProviderSettings client={client} />);

    await screen.findByLabelText("Base URL");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => {
      expect(client.deleteProvider).toHaveBeenCalledTimes(1);
    });
  });

  it("renders the picker with the fetched model list, dropping non-chat ids (embedding/whisper/kokoro/rerank/flux-*)", async () => {
    const provider: Provider = {
      baseUrl: "https://api.example.com/v1",
      imageModel: null,
      chatModel: null,
      hasKey: true,
    };
    const client = stubClient({
      getProvider: mock(() => Promise.resolve(provider)),
      listProviderModels: mock(() =>
        Promise.resolve([
          { id: "gpt-4o-mini" },
          { id: "text-embedding-3-small" },
          { id: "whisper-1" },
          { id: "kokoro-v1" },
          { id: "rerank-english-v3" },
          { id: "flux-2-klein" },
          { id: "claude-haiku" },
        ]),
      ),
    });

    render(<ProviderSettings client={client} />);

    const picker = await screen.findByLabelText("Pick from provider's models") as HTMLSelectElement;
    const optionLabels = Array.from(picker.options).map((o) => o.value).filter(Boolean);
    expect(optionLabels).toEqual(["gpt-4o-mini", "claude-haiku"]);

    fireEvent.change(picker, { target: { value: "gpt-4o-mini" } });
    const chatModelInput = screen.getByLabelText("Chat model") as HTMLInputElement;
    expect(chatModelInput.value).toBe("gpt-4o-mini");
  });

  it("falls back to the free-text chat model field when the model list call fails", async () => {
    const provider: Provider = {
      baseUrl: "https://api.example.com/v1",
      imageModel: null,
      chatModel: null,
      hasKey: true,
    };
    const client = stubClient({
      getProvider: mock(() => Promise.resolve(provider)),
      listProviderModels: mock(() => Promise.reject(new Error("network error"))),
    });

    render(<ProviderSettings client={client} />);

    await screen.findByLabelText("Base URL");
    expect(screen.queryByLabelText("Pick from provider's models")).toBeNull();

    const chatModelInput = screen.getByLabelText("Chat model") as HTMLInputElement;
    fireEvent.change(chatModelInput, { target: { value: "custom-chat-model" } });
    expect(chatModelInput.value).toBe("custom-chat-model");
  });
});
