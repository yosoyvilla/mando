import { useState } from "react";
import { useAuth } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/error-message";

interface LoginViewProps {
  onSuccess?: () => void;
}

// Plain native form controls (not react-aria) on purpose: this is the
// gate every unauthenticated user hits, so it needs to render and be
// drivable (by tests and by Playwright in Phase 8) without any portal or
// overlay machinery in the way. Native `<input>`/`<label>` give stable,
// implicit ARIA roles for free.
export function LoginView({ onSuccess }: LoginViewProps) {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
      onSuccess?.();
    } catch (err) {
      setError(getErrorMessage(err) ?? "Invalid email or password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-dvh items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        aria-label="Log in"
        className="w-full max-w-sm space-y-4"
      >
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold text-fg">Mando</h1>
          <p className="text-sm text-muted-fg">
            Sign in to manage your paired machines.
          </p>
        </div>

        <div className="space-y-1">
          <label htmlFor="login-email" className="text-sm font-medium text-fg">
            Email
          </label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-lg border border-input bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
          />
        </div>

        <div className="space-y-1">
          <label
            htmlFor="login-password"
            className="text-sm font-medium text-fg"
          >
            Password
          </label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-lg border border-input bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
          />
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg"
          >
            {error}
          </div>
        )}

        <Button type="submit" isDisabled={submitting} className="w-full">
          {submitting ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
