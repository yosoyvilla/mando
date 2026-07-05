import { describe, it, expect, mock } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { AuthProvider } from "../src/contexts/auth-context";
import { useAuth } from "../src/contexts/auth-context";
import { RequireAuth } from "../src/components/require-auth";
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
    getProvider: mock(() => Promise.reject(new Error("not implemented"))),
    setProvider: mock(() => Promise.reject(new Error("not implemented"))),
    deleteProvider: mock(() => Promise.reject(new Error("not implemented"))),
    generateImage: mock(() => Promise.reject(new Error("not implemented"))),
    editImage: mock(() => Promise.reject(new Error("not implemented"))),
    listImages: mock(() => Promise.reject(new Error("not implemented"))),
    imageRawUrl: mock((id: string) => `/api/v1/images/${id}/raw`),
    deleteImage: mock(() => Promise.reject(new Error("not implemented"))),
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

// Builds a minimal two-route tree (a protected route + `/login`) so
// RequireAuth's real <Navigate> can be exercised end to end, including its
// `useLocation()` call which needs an actual router context.
function buildTestRouter(initialPath: string) {
  const rootRoute = createRootRoute();
  const protectedRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/pair",
    component: () => (
      <RequireAuth>
        <div>Protected content</div>
      </RequireAuth>
    ),
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    validateSearch: (search: Record<string, unknown>) => ({
      redirect: typeof search.redirect === "string" ? search.redirect : undefined,
    }),
    component: () => <div>Login page</div>,
  });
  const routeTree = rootRoute.addChildren([protectedRoute, loginRoute]);

  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

describe("RequireAuth", () => {
  it("redirects unauthenticated users to /login, preserving the original path+search as ?redirect=", async () => {
    const client = stubClient(() => Promise.resolve(null));
    const router = buildTestRouter("/pair?code=ABCD-1234");

    render(
      <AuthProvider client={client}>
        <RouterProvider router={router} />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/login"),
    );
    expect(router.state.location.search).toEqual({
      redirect: "/pair?code=ABCD-1234",
    });
    expect(screen.getByText("Login page")).toBeInTheDocument();
  });

  it("lets authenticated users reach the protected route without redirecting", async () => {
    const client = stubClient(() =>
      Promise.resolve({ id: "u1", email: "a@b.com" }),
    );
    const router = buildTestRouter("/pair?code=ABCD-1234");

    render(
      <AuthProvider client={client}>
        <RouterProvider router={router} />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText("Protected content")).toBeInTheDocument(),
    );
    expect(router.state.location.pathname).toBe("/pair");
  });
});
