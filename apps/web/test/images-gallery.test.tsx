import { describe, it, expect, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImagesGallery } from "../src/components/images-gallery";
import { HubClientError, type GeneratedImage, type HubClient } from "../src/lib/hub-client";
import { useEditSourceStore } from "../src/stores/edit-source-store";

function stubClient(overrides: Partial<HubClient> = {}): HubClient {
  return {
    login: mock(() => Promise.reject(new Error("not implemented"))),
    logout: mock(() => Promise.reject(new Error("not implemented"))),
    me: mock(() => Promise.reject(new Error("not implemented"))),
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
    listProviderModels: mock(() => Promise.reject(new Error("not implemented"))),
    generateImage: mock(() => Promise.reject(new Error("not implemented"))),
    editImage: mock(() => Promise.reject(new Error("not implemented"))),
    listImages: mock(() => Promise.resolve([])),
    imageRawUrl: mock((id: string) => `/api/v1/images/${id}/raw`),
    deleteImage: mock(() => Promise.resolve()),
    listConversations: mock(() => Promise.reject(new Error("not implemented"))),
    createConversation: mock(() => Promise.reject(new Error("not implemented"))),
    getConversation: mock(() => Promise.reject(new Error("not implemented"))),
    deleteConversation: mock(() => Promise.reject(new Error("not implemented"))),
    streamMessage: mock(() => Promise.reject(new Error("not implemented"))),
    ...overrides,
  };
}

function image(overrides: Partial<GeneratedImage> = {}): GeneratedImage {
  return {
    id: "img1",
    prompt: "a cat",
    mime: "image/png",
    sourceKind: "generation",
    createdAt: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("ImagesGallery", () => {
  it("renders the gallery from listImages using the same-origin raw URL", async () => {
    const client = stubClient({ listImages: mock(() => Promise.resolve([image()])) });
    render(<ImagesGallery client={client} />);

    const img = (await screen.findByAltText("a cat")) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/v1/images/img1/raw");
  });

  it("shows an empty state when there are no images yet", async () => {
    render(<ImagesGallery client={stubClient()} />);
    await waitFor(() => {
      expect(screen.getByText(/No images yet/)).toBeInTheDocument();
    });
  });

  it("generate calls client.generateImage with the prompt/count and prepends the results to the gallery", async () => {
    const created = image({ id: "img2", prompt: "a dog" });
    const client = stubClient({ generateImage: mock(() => Promise.resolve([created])) });
    render(<ImagesGallery client={client} />);

    await waitFor(() => expect(client.listImages).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "a dog" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => {
      expect(client.generateImage).toHaveBeenCalledWith({ prompt: "a dog", size: undefined, n: 1 });
    });
    expect(await screen.findByAltText("a dog")).toBeInTheDocument();
  });

  it("prepends every image from a multi-image generateImage response", async () => {
    const created = [
      image({ id: "img-a", prompt: "a dog" }),
      image({ id: "img-b", prompt: "a dog" }),
    ];
    const client = stubClient({ generateImage: mock(() => Promise.resolve(created)) });
    render(<ImagesGallery client={client} />);

    await waitFor(() => expect(client.listImages).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "a dog" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => {
      expect(screen.getAllByAltText("a dog")).toHaveLength(2);
    });
  });

  it("regenerate re-posts a gallery item's own prompt as a new generation", async () => {
    const original = image({ id: "img1", prompt: "a cat" });
    const regenerated = image({ id: "img-regen", prompt: "a cat" });
    const client = stubClient({
      listImages: mock(() => Promise.resolve([original])),
      generateImage: mock(() => Promise.resolve([regenerated])),
    });
    render(<ImagesGallery client={client} />);

    const regenButton = await screen.findByRole("button", { name: "Regenerate image: a cat" });
    fireEvent.click(regenButton);

    await waitFor(() => {
      expect(client.generateImage).toHaveBeenCalledWith({ prompt: "a cat", size: undefined });
    });
    await waitFor(() => {
      expect(screen.getAllByAltText("a cat")).toHaveLength(2);
    });
  });

  it("shows a friendly 'set up a provider in Settings first' message on a 400 provider_not_configured response, linking to Settings", async () => {
    const client = stubClient({
      generateImage: mock(() => Promise.reject(new HubClientError("provider_not_configured", 400))),
    });
    render(<ImagesGallery client={client} />);

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "a dog" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Set up a provider in Settings first.");
    });
    expect(screen.getByRole("link", { name: /Go to Settings/ })).toHaveAttribute("href", "/settings");
    expect(screen.queryByText("provider_not_configured")).toBeNull();
  });

  it("edits with an attached source file and the entered prompt", async () => {
    const created = image({ id: "img3", prompt: "make it blue", sourceKind: "edit" });
    const client = stubClient({ editImage: mock(() => Promise.resolve(created)) });
    render(<ImagesGallery client={client} />);

    const file = new File([new Uint8Array([1, 2, 3])], "source.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Source image"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Edit prompt"), { target: { value: "make it blue" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await waitFor(() => {
      expect(client.editImage).toHaveBeenCalledWith({ prompt: "make it blue", size: undefined, image: file });
    });
    expect(await screen.findByAltText("make it blue")).toBeInTheDocument();
  });

  it("Edit on a gallery item sets it as the edit source, and submitting posts sourceImageId (not a re-upload)", async () => {
    const existing = image({ id: "img1", prompt: "a cat" });
    const edited = image({ id: "img-edited", prompt: "a cat but blue", sourceKind: "edit" });
    const client = stubClient({
      listImages: mock(() => Promise.resolve([existing])),
      editImage: mock(() => Promise.resolve(edited)),
    });
    render(<ImagesGallery client={client} />);

    const editButton = await screen.findByRole("button", { name: "Edit image: a cat" });
    fireEvent.click(editButton);

    expect(screen.getByText(/Editing: a cat/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Edit prompt"), { target: { value: "a cat but blue" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await waitFor(() => {
      expect(client.editImage).toHaveBeenCalledWith({
        prompt: "a cat but blue",
        size: undefined,
        sourceImageId: "img1",
      });
    });
    expect(await screen.findByAltText("a cat but blue")).toBeInTheDocument();
  });

  it("preloads a pending edit source from the store (session-image -> edit-in-Images hand-off) on mount", async () => {
    useEditSourceStore.getState().setPendingEditSource({
      dataUrl: "data:image/png;base64,AAAA",
      mime: "image/png",
      filename: "shot.png",
    });

    render(<ImagesGallery client={stubClient()} />);

    expect(await screen.findByText(/Editing: shot.png/)).toBeInTheDocument();
    // Consumed exactly once -- the store no longer holds it.
    expect(useEditSourceStore.getState().pendingEditSource).toBeNull();
  });

  it("deletes an image and removes it from the gallery", async () => {
    const client = stubClient({ listImages: mock(() => Promise.resolve([image()])) });
    render(<ImagesGallery client={client} />);

    const deleteButton = await screen.findByRole("button", { name: /Delete image/ });
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(client.deleteImage).toHaveBeenCalledWith("img1");
    });
    await waitFor(() => {
      expect(screen.queryByAltText("a cat")).toBeNull();
    });
  });
});
