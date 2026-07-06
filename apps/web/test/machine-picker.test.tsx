import { describe, it, expect, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MachinePicker } from "../src/components/machine-picker";
import type { HubClient, Machine } from "../src/lib/hub-client";

function stubClient(machines: Machine[]): HubClient {
  return {
    login: mock(() => Promise.reject(new Error("not implemented"))),
    logout: mock(() => Promise.reject(new Error("not implemented"))),
    me: mock(() => Promise.reject(new Error("not implemented"))),
    listMachines: mock(() => Promise.resolve(machines)),
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
    listImages: mock(() => Promise.reject(new Error("not implemented"))),
    imageRawUrl: mock((id: string) => `/api/v1/images/${id}/raw`),
    deleteImage: mock(() => Promise.reject(new Error("not implemented"))),
    listConversations: mock(() => Promise.reject(new Error("not implemented"))),
    createConversation: mock(() => Promise.reject(new Error("not implemented"))),
    getConversation: mock(() => Promise.reject(new Error("not implemented"))),
    deleteConversation: mock(() => Promise.reject(new Error("not implemented"))),
    streamMessage: mock(() => Promise.reject(new Error("not implemented"))),
  };
}

function machine(overrides: Partial<Machine>): Machine {
  return {
    id: "m1",
    name: "laptop",
    platform: "darwin",
    online: true,
    lastSeenAt: null,
    revokedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    connectDirectory: null,
    ...overrides,
  };
}

describe("MachinePicker", () => {
  it("renders machines from a stubbed HubClient with an online badge", async () => {
    const client = stubClient([
      machine({ id: "m1", name: "laptop", online: true }),
    ]);

    render(<MachinePicker client={client} onSelect={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("laptop")).toBeInTheDocument();
    });
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(client.listMachines).toHaveBeenCalledTimes(1);
  });

  it("renders an offline badge for an offline machine", async () => {
    const client = stubClient([
      machine({ id: "m2", name: "desktop", online: false, lastSeenAt: "2026-01-01T00:00:00.000Z" }),
    ]);

    render(<MachinePicker client={client} onSelect={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("desktop")).toBeInTheDocument();
    });
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("calls onSelect with the chosen online machine", async () => {
    const client = stubClient([machine({ id: "m1", name: "laptop", online: true })]);
    const onSelect = mock((_machine: Machine) => {});

    render(<MachinePicker client={client} onSelect={onSelect} />);

    // Anchored to the start: the card's own select button's accessible
    // name starts with the machine name ("laptop Online Ready"), while the
    // sibling "Revoke laptop" button's name merely contains it -- an
    // unanchored /laptop/ would match both.
    const button = await screen.findByRole("button", { name: /^laptop/ });
    fireEvent.click(button);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: "m1" });
  });

  it("disables selecting an offline machine", async () => {
    const client = stubClient([machine({ id: "m2", name: "desktop", online: false })]);

    render(<MachinePicker client={client} onSelect={() => {}} />);

    const button = await screen.findByRole("button", { name: /^desktop/ });
    expect(button).toBeDisabled();
  });

  it("shows an empty state when there are no paired machines", async () => {
    const client = stubClient([]);

    render(<MachinePicker client={client} onSelect={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/No machines paired yet/)).toBeInTheDocument();
    });
  });

  it("hides a revoked machine instead of showing a permanently-offline card", async () => {
    const client = stubClient([
      machine({ id: "m1", name: "laptop", online: false, revokedAt: "2026-01-01T00:00:00.000Z" }),
      machine({ id: "m2", name: "desktop", online: true }),
    ]);

    render(<MachinePicker client={client} onSelect={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("desktop")).toBeInTheDocument();
    });
    expect(screen.queryByText("laptop")).not.toBeInTheDocument();
  });

  it("revoking a machine calls HubClient.revokeMachine and refreshes the list", async () => {
    const client = stubClient([machine({ id: "m1", name: "laptop", online: true })]);
    client.revokeMachine = mock(() => Promise.resolve());

    render(<MachinePicker client={client} onSelect={() => {}} />);

    const revokeButton = await screen.findByRole("button", { name: "Revoke laptop" });
    fireEvent.click(revokeButton);

    await waitFor(() => {
      expect(client.revokeMachine).toHaveBeenCalledWith("m1");
    });
    // load() re-runs after a successful revoke to pick up the new state.
    expect(client.listMachines).toHaveBeenCalledTimes(2);
  });
});
