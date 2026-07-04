import { describe, it, expect, mock } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider } from "../src/contexts/auth-context";
import { useAuth } from "../src/contexts/auth-context";
import type { HubClient, HubUser } from "../src/lib/hub-client";

function stubClient(me: () => Promise<HubUser | null>): HubClient {
  return {
    login: mock(() => Promise.reject(new Error("not implemented"))),
    logout: mock(() => Promise.reject(new Error("not implemented"))),
    me: mock(me),
    listMachines: mock(() => Promise.reject(new Error("not implemented"))),
    getMachine: mock(() => Promise.reject(new Error("not implemented"))),
    revokeMachine: mock(() => Promise.reject(new Error("not implemented"))),
    approvePairing: mock(() => Promise.reject(new Error("not implemented"))),
    opencode: mock(() => {
      throw new Error("not implemented");
    }),
  };
}

// A minimal stand-in for the real gate (which renders <Navigate> and needs
// a router context) -- this exercises the same `useAuth().status` values
// RequireAuth/`_app` branch on, without pulling in TanStack Router.
function Gate() {
  const { status } = useAuth();
  if (status === "loading") return <div>Loading...</div>;
  if (status === "unauthenticated") return <div>Login</div>;
  return <div>App</div>;
}

describe("AuthProvider gating", () => {
  it("shows the app once me() resolves to a user", async () => {
    const client = stubClient(() =>
      Promise.resolve({ id: "u1", email: "a@b.com" }),
    );

    render(
      <AuthProvider client={client}>
        <Gate />
      </AuthProvider>,
    );

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("App")).toBeInTheDocument());
  });

  it("shows the login gate when me() returns null (no session)", async () => {
    const client = stubClient(() => Promise.resolve(null));

    render(
      <AuthProvider client={client}>
        <Gate />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText("Login")).toBeInTheDocument(),
    );
    expect(screen.queryByText("App")).not.toBeInTheDocument();
  });

  it("treats a rejected me() the same as no session", async () => {
    const client = stubClient(() => Promise.reject(new Error("network")));

    render(
      <AuthProvider client={client}>
        <Gate />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText("Login")).toBeInTheDocument(),
    );
  });
});
