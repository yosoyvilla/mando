import { useState } from "react";
import { Navigate, useRouter } from "@tanstack/react-router";
import { useAuth } from "@/contexts/auth-context";
import { Loader } from "@/components/ui/loader";

// Shared gate for any top-level route that requires a signed-in hub user
// (the `/_app` layout, `/machines`, `/pair`). Redirects to `/login` when
// `HubClient.me()` resolved to no session, preserving the current path+search
// (e.g. a `/pair?code=...` deep link) in `?redirect=` so login can send the
// user back to where they started instead of dropping them on `/`.
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  // `useRouter()` just reads the router instance from context -- unlike
  // `useLocation()`, it doesn't subscribe to location changes. That matters
  // here: once the redirect below fires, a *reactive* read would start
  // reflecting the in-flight navigation to `/login` itself, nesting that
  // target into its own `redirect` param on every re-render (an ever-growing
  // search string and an infinite update loop). Reading the href once at
  // mount, before any navigation happens, avoids that entirely.
  const router = useRouter();
  const [returnTo] = useState(() => router.state.location.href);

  if (status === "loading") {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Loader className="size-6" />
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <Navigate to="/login" search={{ redirect: returnTo }} />;
  }

  return <>{children}</>;
}
