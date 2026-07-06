import { describe, it, expect, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UsersAdmin } from "../src/routes/_app/users";
import { HubClientError, type AdminUser, type HubClient } from "../src/lib/hub-client";

function stubClient(overrides: Partial<HubClient> = {}): HubClient {
  return {
    login: mock(() => Promise.reject(new Error("not implemented"))),
    logout: mock(() => Promise.reject(new Error("not implemented"))),
    me: mock(() => Promise.reject(new Error("not implemented"))),
    createUser: mock(() => Promise.reject(new Error("not implemented"))),
    listUsers: mock(() => Promise.resolve([])),
    adminDeleteUser: mock(() => Promise.resolve()),
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

function adminUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: "u1",
    email: "person@example.com",
    isAdmin: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("UsersAdmin", () => {
  it("renders the user list with emails and an admin badge on admin rows", async () => {
    const users = [
      adminUser({ id: "u1", email: "member@example.com", isAdmin: false }),
      adminUser({ id: "u2", email: "root@example.com", isAdmin: true }),
    ];
    const client = stubClient({ listUsers: mock(() => Promise.resolve(users)) });

    render(<UsersAdmin client={client} currentUserId="u1" />);

    await screen.findByText("member@example.com");
    expect(screen.getByText("root@example.com")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("shows 'No other users yet.' when the list is empty", async () => {
    const client = stubClient({ listUsers: mock(() => Promise.resolve([])) });
    render(<UsersAdmin client={client} currentUserId="u1" />);
    await screen.findByText("No other users yet.");
  });

  it("creates a user and shows the temp password exactly once in a copyable panel", async () => {
    const client = stubClient({
      listUsers: mock(() => Promise.resolve([])),
      createUser: mock(() =>
        Promise.resolve({ user: { id: "u9", email: "new@example.com" }, tempPassword: "s3cr3t-once" }),
      ),
    });

    render(<UsersAdmin client={client} currentUserId="u1" />);
    await screen.findByText("No other users yet.");

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => {
      expect(client.createUser).toHaveBeenCalledWith("new@example.com");
    });

    await screen.findByText("s3cr3t-once");
    // Exactly one occurrence of the temp password on screen.
    expect(screen.getAllByText("s3cr3t-once")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("surfaces a duplicate-email error from createUser without crashing", async () => {
    const client = stubClient({
      listUsers: mock(() => Promise.resolve([])),
      createUser: mock(() => Promise.reject(new HubClientError("email already invited", 409))),
    });

    render(<UsersAdmin client={client} currentUserId="u1" />);
    await screen.findByText("No other users yet.");

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dupe@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("email already invited");
    });
    // Did not crash: the invite form is still present and usable.
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("hides the delete control on the acting user's own row, and deletes another row after confirm", async () => {
    const users = [
      adminUser({ id: "u1", email: "me@example.com", isAdmin: true }),
      adminUser({ id: "u2", email: "other@example.com", isAdmin: false }),
    ];
    const client = stubClient({
      listUsers: mock(() => Promise.resolve(users)),
      adminDeleteUser: mock(() => Promise.resolve()),
    });

    render(<UsersAdmin client={client} currentUserId="u1" />);
    await screen.findByText("me@example.com");

    expect(screen.queryByRole("button", { name: /Delete user: me@example.com/ })).toBeNull();
    expect(screen.getByText(/This is you/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Delete user: other@example.com/ }));

    const confirmButton = await screen.findByRole("button", { name: "Delete" });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(client.adminDeleteUser).toHaveBeenCalledWith("u2");
    });
  });
});
