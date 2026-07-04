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
