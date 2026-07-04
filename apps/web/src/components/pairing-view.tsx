import { useState } from "react";
import { hubClient as defaultHubClient } from "@/lib/hub-client-instance";
import type { HubClient } from "@/lib/hub-client";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/error-message";

interface PairingViewProps {
  // Pre-fills the code field from the `?code=` deep link the `mando`
  // pairing flow prints/opens. The field stays editable so a user can also
  // type the code by hand.
  initialCode?: string;
  client?: HubClient;
}

type PairingState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; machineId: string }
  | { status: "error"; message: string };

// Browser side of the `/mando` pairing flow: reads (or accepts) a pairing
// code and calls `HubClient.approvePairing(code)`, which requires an
// authenticated hub user -- render this behind `RequireAuth`.
export function PairingView({
  initialCode = "",
  client = defaultHubClient,
}: PairingViewProps) {
  const [code, setCode] = useState(initialCode);
  const [state, setState] = useState<PairingState>({ status: "idle" });

  async function handleApprove(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || state.status === "submitting") return;

    setState({ status: "submitting" });
    try {
      const result = await client.approvePairing(trimmed);
      setState({ status: "success", machineId: result.machineId });
    } catch (err) {
      setState({
        status: "error",
        message: getErrorMessage(err) ?? "Failed to approve pairing",
      });
    }
  }

  return (
    <div className="flex h-dvh items-center justify-center px-4">
      <form
        onSubmit={handleApprove}
        aria-label="Approve machine pairing"
        className="w-full max-w-sm space-y-4"
      >
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold text-fg">Pair a machine</h1>
          <p className="text-sm text-muted-fg">
            Enter the pairing code shown by <code>mando</code> to link that
            machine to your account.
          </p>
        </div>

        <div className="space-y-1">
          <label
            htmlFor="pairing-code"
            className="text-sm font-medium text-fg"
          >
            Pairing code
          </label>
          <input
            id="pairing-code"
            name="code"
            type="text"
            autoComplete="off"
            spellCheck={false}
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="w-full rounded-lg border border-input bg-bg px-3 py-2 text-sm font-mono text-fg outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
          />
        </div>

        {state.status === "success" && (
          <div
            role="status"
            className="rounded-md bg-success-subtle px-3 py-2 text-sm text-success-subtle-fg"
          >
            Machine paired successfully. Select it from the machine picker to
            connect.
          </div>
        )}

        {state.status === "error" && (
          <div
            role="alert"
            className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg"
          >
            {state.message}
          </div>
        )}

        <Button
          type="submit"
          isDisabled={state.status === "submitting" || !code.trim()}
          className="w-full"
        >
          {state.status === "submitting" ? "Approving..." : "Approve"}
        </Button>
      </form>
    </div>
  );
}
