import { Navigate } from "@tanstack/react-router";
import { useAuth } from "@/contexts/auth-context";
import { Loader } from "@/components/ui/loader";

// Shared gate for any top-level route that requires a signed-in hub user
// (the `/_app` layout, `/machines`, `/pair`). Redirects to `/login` when
// `HubClient.me()` resolved to no session.
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Loader className="size-6" />
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <Navigate to="/login" />;
  }

  return <>{children}</>;
}
