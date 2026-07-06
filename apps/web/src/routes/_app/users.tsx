import { useCallback, useEffect, useId, useState } from "react";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { ModalOverlay, Modal } from "react-aria-components";
import { hubClient as defaultHubClient } from "@/lib/hub-client-instance";
import { type AdminUser, type HubClient } from "@/lib/hub-client";
import { useAuth } from "@/contexts/auth-context";
import { useBreadcrumb } from "@/contexts/breadcrumb-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/error-message";

// Admin-only (backend requireAdmin enforces the real boundary -- see
// apps/hub/src/users/routes.ts). Redirecting non-admins here is
// defense-in-depth/UX only; it does not substitute for the server check.
export const Route = createFileRoute("/_app/users")({
  component: UsersPage,
});

function UsersPage() {
  const { user } = useAuth();
  const { setPageTitle } = useBreadcrumb();

  useEffect(() => {
    setPageTitle("Users");
    return () => setPageTitle(null);
  }, [setPageTitle]);

  if (!user?.isAdmin) return <Navigate to="/" />;
  return <UsersAdmin currentUserId={user.id} />;
}

type ListState =
  | { status: "loading" }
  | { status: "ready"; users: AdminUser[] }
  | { status: "error"; message: string };

interface UsersAdminProps {
  client?: HubClient;
  currentUserId: string;
}

function formatCreatedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

// The temp password returned by createUser() is the one moment that carries
// weight: the hub's POST /api/v1/auth/invite generates it and hands it back
// exactly once -- there is no way to retrieve it again afterwards (see
// hub-client.ts's createUser doc comment). It's held only in this component's
// own state (never persisted, never re-fetched) and rendered in a clearly
// bounded panel with a Copy action until the admin creates the next user or
// navigates away.
export function UsersAdmin({ client = defaultHubClient, currentUserId }: UsersAdminProps) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [email, setEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdUser, setCreatedUser] = useState<{ email: string; tempPassword: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const dialogHeadingId = useId();

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const users = await client.listUsers();
      setState({ status: "ready", users });
    } catch (err) {
      setState({
        status: "error",
        message: getErrorMessage(err) ?? "Failed to load users.",
      });
    }
  }, [client]);

  useEffect(() => {
    load();
    // `client` is a stable singleton/prop in practice (same pattern as
    // provider-settings.tsx/images-gallery.tsx) -- re-running on every
    // render would refetch in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (creating || !email.trim()) return;

    setCreating(true);
    setCreateError(null);
    try {
      const { user: created, tempPassword } = await client.createUser(email.trim());
      setCreatedUser({ email: created.email, tempPassword });
      setCopied(false);
      setEmail("");
      await load();
    } catch (err) {
      setCreateError(getErrorMessage(err) ?? "Failed to create user.");
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy() {
    if (!createdUser) return;
    try {
      await navigator.clipboard.writeText(createdUser.tempPassword);
      setCopied(true);
      toast.success("Temporary password copied.");
    } catch {
      toast.error("Couldn't copy -- select and copy the password manually.");
    }
  }

  async function handleConfirmDelete() {
    if (!pendingDelete || deleting) return;

    setDeleting(true);
    setDeleteError(null);
    try {
      await client.adminDeleteUser(pendingDelete.id);
      setPendingDelete(null);
      toast.success("User deleted.");
      await load();
    } catch (err) {
      setDeleteError(getErrorMessage(err) ?? "Failed to delete user.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="container mx-auto max-w-3xl space-y-8 px-4 py-10">
      <div className="space-y-2">
        <h1 className="bg-gradient-to-r from-fg to-muted-fg bg-clip-text text-3xl font-bold tracking-tight text-transparent sm:text-4xl">
          Users
        </h1>
        <p className="text-lg text-muted-fg">
          Invite people to this hub and manage who has access.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Invite a user</h2>
        <form
          onSubmit={handleCreate}
          aria-label="Invite a user"
          className="flex max-w-sm items-end gap-2"
        >
          <div className="flex-1 space-y-1">
            <Label htmlFor="users-invite-email">Email</Label>
            <Input
              id="users-invite-email"
              name="email"
              type="email"
              placeholder="person@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>
          <Button type="submit" isDisabled={creating || !email.trim()}>
            {creating ? "Inviting..." : "Invite"}
          </Button>
        </form>

        {createError && (
          <div
            role="alert"
            className="max-w-sm rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg"
          >
            {createError}
          </div>
        )}

        {createdUser && (
          <div className="max-w-sm space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3 text-sm">
            <p>
              Temporary password for <strong>{createdUser.email}</strong>:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-sm">
                {createdUser.tempPassword}
              </code>
              <Button type="button" size="xs" intent="outline" onPress={handleCopy}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-muted-fg">
              This is shown once and will not be shown again -- give it to{" "}
              {createdUser.email} now.
            </p>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">All users</h2>

        {state.status === "loading" && (
          <p className="text-sm text-muted-fg">Loading users...</p>
        )}

        {state.status === "error" && (
          <div
            role="alert"
            className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg"
          >
            {state.message}
          </div>
        )}

        {state.status === "ready" && state.users.length === 0 && (
          <p className="text-sm text-muted-fg">No other users yet.</p>
        )}

        {state.status === "ready" && state.users.length > 0 && (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {state.users.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{u.email}</span>
                    {u.isAdmin && <Badge intent="secondary">Admin</Badge>}
                  </div>
                  <p className="text-xs text-muted-fg">Joined {formatCreatedAt(u.createdAt)}</p>
                </div>
                {u.id === currentUserId ? (
                  <span className="shrink-0 text-xs text-muted-fg">This is you</span>
                ) : (
                  <Button
                    type="button"
                    size="xs"
                    intent="danger"
                    aria-label={`Delete user: ${u.email}`}
                    onPress={() => {
                      setDeleteError(null);
                      setPendingDelete(u);
                    }}
                  >
                    Delete
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ModalOverlay
        isOpen={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        isDismissable
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      >
        <Modal className="w-full max-w-md">
          <Dialog aria-labelledby={dialogHeadingId} className="rounded-lg border border-border bg-overlay">
            <DialogHeader>
              <h2 id={dialogHeadingId} className="text-base font-semibold text-fg">
                Delete {pendingDelete?.email}?
              </h2>
            </DialogHeader>
            <DialogBody className="space-y-3">
              <p className="text-sm text-muted-fg">
                This removes their access to this hub immediately. This cannot be undone.
              </p>
              {deleteError && (
                <div
                  role="alert"
                  className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg"
                >
                  {deleteError}
                </div>
              )}
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                intent="plain"
                onPress={() => setPendingDelete(null)}
                isDisabled={deleting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                intent="danger"
                onPress={handleConfirmDelete}
                isDisabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete"}
              </Button>
            </DialogFooter>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}
