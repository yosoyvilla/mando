import { describe, it, expect, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChangePassword } from "../src/components/change-password";
import { HubClientError, type HubClient } from "../src/lib/hub-client";

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

function fillForm(current: string, next: string, confirm: string) {
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: next } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: confirm } });
}

describe("ChangePassword", () => {
  it("calls changePassword(current,new) and shows a note that other sessions were signed out", async () => {
    const client = stubClient({ changePassword: mock(() => Promise.resolve()) });
    render(<ChangePassword client={client} />);

    fillForm("old-password", "new-password-123", "new-password-123");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => {
      expect(client.changePassword).toHaveBeenCalledWith("old-password", "new-password-123");
    });

    expect(await screen.findByText(/other sessions/i)).toBeInTheDocument();
    expect(screen.getByText(/signed out/i)).toBeInTheDocument();
  });

  it("shows a validation error and does NOT call the client when the confirmation does not match", async () => {
    const client = stubClient();
    render(<ChangePassword client={client} />);

    fillForm("old-password", "new-password-123", "does-not-match");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("New password and confirmation do not match.");
    });
    expect(client.changePassword).not.toHaveBeenCalled();
  });

  it("shows a validation error and does NOT call the client when the new password is too short", async () => {
    const client = stubClient();
    render(<ChangePassword client={client} />);

    fillForm("old-password", "short1", "short1");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("New password must be at least 8 characters.");
    });
    expect(client.changePassword).not.toHaveBeenCalled();
  });

  it("surfaces a HubClientError (wrong current password) without crashing", async () => {
    const client = stubClient({
      changePassword: mock(() => Promise.reject(new HubClientError("current password is incorrect", 400))),
    });
    render(<ChangePassword client={client} />);

    fillForm("wrong-password", "new-password-123", "new-password-123");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("current password is incorrect");
    });
    // Did not crash: the form is still present and usable.
    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
  });
});
