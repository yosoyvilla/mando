import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SendToSessionDialog } from "../src/components/send-to-session-dialog";
import { MAX_ATTACHMENT_TOTAL_BYTES } from "../src/lib/attachments";
import type { GeneratedImage, HubClient, Machine } from "../src/lib/hub-client";

function stubClient(overrides: Partial<HubClient> = {}): HubClient {
  return {
    login: mock(() => Promise.reject(new Error("not implemented"))),
    logout: mock(() => Promise.reject(new Error("not implemented"))),
    me: mock(() => Promise.reject(new Error("not implemented"))),
    listMachines: mock(() => Promise.resolve([])),
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

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "m1",
    name: "Machine One",
    platform: "darwin",
    online: true,
    lastSeenAt: null,
    revokedAt: null,
    createdAt: "2026-07-05T00:00:00.000Z",
    connectDirectory: null,
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

function sessionListResponse(sessions: unknown[]): Response {
  return new Response(JSON.stringify(sessions), { status: 200 });
}

// Builds an `opencode(machineId)` proxy stub whose `fetch` branches on
// method: GET (session list) returns `sessions`, POST (send-message)
// returns `postResponse` and is captured for assertions.
function opencodeStub(sessions: unknown[], postResponse: Response = new Response("{}", { status: 200 })) {
  const fetchMock = mock((path: string, init?: RequestInit) => {
    if (init?.method === "POST") return Promise.resolve(postResponse);
    return Promise.resolve(sessionListResponse(sessions));
  });
  return { fetch: fetchMock, events: mock(() => new EventSource("about:blank")) };
}

function stubImageFetch(blobSize: number, mime = "image/png"): void {
  const bytes = new Uint8Array(blobSize);
  globalThis.fetch = mock((url: string) => {
    if (typeof url === "string" && url.includes("/raw")) {
      return Promise.resolve(new Response(bytes, { status: 200, headers: { "Content-Type": mime } }));
    }
    // A data: URL read by fileToDataUrl's underlying FileReader never goes
    // through fetch -- only the raw-image GET does.
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;

describe("SendToSessionDialog", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds the correct file part and posts it to the chosen session", async () => {
    stubImageFetch(100);
    const m = machine();
    const opencode = opencodeStub([{ id: "s1", title: "Session One", time: { created: 1, updated: 2 } }]);
    const client = stubClient({
      listMachines: mock(() => Promise.resolve([m])),
      opencode: mock(() => opencode),
    });

    render(<SendToSessionDialog image={image()} isOpen onClose={() => {}} client={client} />);

    const machineSelect = await screen.findByLabelText("Machine");
    fireEvent.change(machineSelect, { target: { value: "m1" } });

    const sessionSelect = await screen.findByLabelText("Session");
    fireEvent.change(sessionSelect, { target: { value: "s1" } });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(opencode.fetch).toHaveBeenCalledWith(
        "/session/s1/message",
        expect.objectContaining({ method: "POST" }),
      );
    });

    const postCall = opencode.fetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    const body = JSON.parse((postCall?.[1] as RequestInit).body as string);
    expect(body.parts).toHaveLength(1);
    expect(body.parts[0]).toMatchObject({ type: "file", mime: "image/png" });
    expect(body.parts[0].url).toMatch(/^data:image\/png;base64,/);

    await screen.findByRole("status");
  });

  it("blocks sending an image over the 8MB cap, before ever posting to the session", async () => {
    stubImageFetch(MAX_ATTACHMENT_TOTAL_BYTES + 1);
    const m = machine();
    const opencode = opencodeStub([{ id: "s1", title: "Session One", time: { created: 1, updated: 2 } }]);
    const client = stubClient({
      listMachines: mock(() => Promise.resolve([m])),
      opencode: mock(() => opencode),
    });

    render(<SendToSessionDialog image={image()} isOpen onClose={() => {}} client={client} />);

    fireEvent.change(await screen.findByLabelText("Machine"), { target: { value: "m1" } });
    fireEvent.change(await screen.findByLabelText("Session"), { target: { value: "s1" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/too large to send into a session/);
    });
    expect(opencode.fetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(
      false,
    );
  });

  it("shows an offline warning and never fetches sessions for an offline machine", async () => {
    const m = machine({ id: "m-off", name: "Offline Box", online: false });
    const client = stubClient({ listMachines: mock(() => Promise.resolve([m])) });

    render(<SendToSessionDialog image={image()} isOpen onClose={() => {}} client={client} />);

    await screen.findByText(/Offline Box \(offline\)/);
    expect(screen.queryByLabelText("Session")).toBeNull();
  });

  it("shows a 'no sessions' message when the chosen machine has none", async () => {
    const m = machine();
    const opencode = opencodeStub([]);
    const client = stubClient({
      listMachines: mock(() => Promise.resolve([m])),
      opencode: mock(() => opencode),
    });

    render(<SendToSessionDialog image={image()} isOpen onClose={() => {}} client={client} />);
    fireEvent.change(await screen.findByLabelText("Machine"), { target: { value: "m1" } });

    await screen.findByText(/No sessions on this machine yet/);
  });

  it("shows a 'no paired machines' message when there are none", async () => {
    const client = stubClient({ listMachines: mock(() => Promise.resolve([])) });
    render(<SendToSessionDialog image={image()} isOpen onClose={() => {}} client={client} />);
    await screen.findByText(/No paired machines yet/);
  });
});
