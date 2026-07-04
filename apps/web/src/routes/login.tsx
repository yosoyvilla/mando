import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/contexts/auth-context";
import { LoginView } from "@/components/login-view";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { status } = useAuth();
  const navigate = useNavigate();

  // Already signed in (e.g. direct nav to /login with a live session) --
  // skip straight past the form.
  if (status === "authenticated") {
    return <Navigate to="/" />;
  }

  return <LoginView onSuccess={() => navigate({ to: "/" })} />;
}
