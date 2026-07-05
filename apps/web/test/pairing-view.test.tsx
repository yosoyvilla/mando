import { describe, it, expect, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PairingView } from "../src/components/pairing-view";
import type { HubClient } from "../src/lib/hub-client";

function stubClient(overrides: Partial<HubClient> = {}): HubClient {
  return {
    login: mock(() => Promise.reject(new Error("not implemented"))),
    logout: mock(() => Promise.reject(new Error("not implemented"))),
    me: mock(() => Promise.reject(new Error("not implemented"))),
    listMachines: mock(() => Promise.reject(new Error("not implemented"))),
    getMachine: mock(() => Promise.reject(new Error("not implemented"))),
    revokeMachine: mock(() => Promise.reject(new Error("not implemented"))),
    approvePairing: mock(() => Promise.resolve({ machineId: "m1" })),
    opencode: mock(() => {
      throw new Error("not implemented");
    }),
    getProvider: mock(() => Promise.reject(new Error("not implemented"))),
    setProvider: mock(() => Promise.reject(new Error("not implemented"))),
    deleteProvider: mock(() => Promise.reject(new Error("not implemented"))),
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

describe("PairingView", () => {
  it("pre-fills the code field from the ?code= deep link", () => {
    const client = stubClient();
    render(<PairingView initialCode="ABC123" client={client} />);

    expect(screen.getByLabelText("Pairing code")).toHaveValue("ABC123");
  });

  it("calls approvePairing with the code from ?code= on submit", async () => {
    const client = stubClient();
    render(<PairingView initialCode="XYZ789" client={client} />);

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => {
      expect(client.approvePairing).toHaveBeenCalledWith("XYZ789");
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      /paired successfully/i,
    );
  });

  it("shows an error when approval fails", async () => {
    const client = stubClient({
      approvePairing: mock(() => Promise.reject(new Error("bad code"))),
    });
    render(<PairingView initialCode="BADCODE" client={client} />);

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("bad code");
  });
});
