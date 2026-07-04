import { createRootRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { RouterProvider } from "react-aria-components";
import { ThemeProvider } from "@/providers/theme-provider";
import { AuthProvider, useAuth } from "@/contexts/auth-context";
import { Toast } from "@/components/ui/toast";
import Cmd from "@/components/cmd";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </ThemeProvider>
  );
}

function AppShell() {
  const navigate = useNavigate();
  const { status } = useAuth();

  return (
    <RouterProvider navigate={(path) => navigate({ to: path })}>
      <div className="page">
        <section className="content">
          <Outlet />
        </section>
        {/* The command palette drives session/machine switching, which is
            meaningless before a hub session exists -- mount it only once
            signed in so it doesn't fire authenticated-only fetches from
            the login/pairing screens. */}
        {status === "authenticated" && <Cmd />}
        <Toast position="top-right" />
      </div>
    </RouterProvider>
  );
}
