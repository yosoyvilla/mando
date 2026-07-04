import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/contexts/auth-context";
import { LoginView } from "@/components/login-view";
import { getSafePostLoginRedirect } from "@/lib/safe-redirect";

interface LoginSearch {
  redirect?: string;
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  component: LoginPage,
});

function LoginPage() {
  const { status } = useAuth();
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const destination = getSafePostLoginRedirect(redirect);

  // Already signed in (e.g. direct nav to /login with a live session) --
  // skip straight past the form, honoring a pending pairing deep link.
  if (status === "authenticated") {
    return <Navigate to={destination} />;
  }

  return <LoginView onSuccess={() => navigate({ to: destination })} />;
}
