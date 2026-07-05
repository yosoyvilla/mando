import { describe, it, expect, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LoginView } from "../src/components/login-view";
import { AuthProvider } from "../src/contexts/auth-context";
import type { HubClient } from "../src/lib/hub-client";

function stubClient(overrides: Partial<HubClient> = {}): HubClient {
  return {
    login: mock(() =>
      Promise.resolve({ user: { id: "u1", email: "a@b.com" } }),
    ),
    logout: mock(() => Promise.reject(new Error("not implemented"))),
    me: mock(() => Promise.resolve(null)),
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
    ...overrides,
  };
}

describe("LoginView", () => {
  it("calls HubClient.login with the entered credentials and reports success", async () => {
    const client = stubClient();
    const onSuccess = mock(() => {});

    render(
      <AuthProvider client={client}>
        <LoginView onSuccess={onSuccess} />
      </AuthProvider>,
    );

    // Wait past the initial `me()` check so the form isn't unmounted mid-submit.
    await waitFor(() => expect(client.me).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "a@b.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(client.login).toHaveBeenCalledWith("a@b.com", "hunter2");
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it("shows an error message when login fails", async () => {
    const client = stubClient({
      login: mock(() => Promise.reject(new Error("Invalid credentials"))),
    });

    render(
      <AuthProvider client={client}>
        <LoginView />
      </AuthProvider>,
    );

    await waitFor(() => expect(client.me).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "a@b.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid credentials",
    );
  });
});
