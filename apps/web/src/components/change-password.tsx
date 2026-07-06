import { useState } from "react";
import { hubClient as defaultHubClient } from "@/lib/hub-client-instance";
import { type HubClient } from "@/lib/hub-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/error-message";

// Mirrors the hub's own minimum (see changePassword's server-side check in
// apps/hub/src/users/routes.ts) so a too-short password is rejected here,
// before a round trip, rather than only after the server 400s.
const MIN_PASSWORD_LENGTH = 8;

interface ChangePasswordProps {
  client?: HubClient;
}

export function ChangePassword({ client = defaultHubClient }: ChangePasswordProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;

    setFormError(null);
    setChanged(false);

    // Client-side checks only -- the hub re-validates both on
    // POST /api/v1/me/password regardless, so these just avoid a round
    // trip for the common mistakes.
    if (newPassword !== confirmPassword) {
      setFormError("New password and confirmation do not match.");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setFormError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setSaving(true);
    try {
      await client.changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setChanged(true);
      toast.success("Password changed.");
    } catch (err) {
      setFormError(getErrorMessage(err) ?? "Failed to change password.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Change password" className="max-w-sm space-y-6">
      <div className="space-y-1">
        <Label htmlFor="change-password-current">Current password</Label>
        <Input
          id="change-password-current"
          name="currentPassword"
          type="password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          required
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="change-password-new">New password</Label>
        <Input
          id="change-password-new"
          name="newPassword"
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="change-password-confirm">Confirm new password</Label>
        <Input
          id="change-password-confirm"
          name="confirmPassword"
          type="password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
        />
      </div>

      {formError && (
        <div role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
          {formError}
        </div>
      )}

      {changed && (
        <div role="status" className="rounded-md bg-success-subtle px-3 py-2 text-sm text-success-subtle-fg">
          Password changed. Your other sessions have been signed out.
        </div>
      )}

      <Button type="submit" isDisabled={saving}>
        {saving ? "Changing..." : "Change password"}
      </Button>
    </form>
  );
}
