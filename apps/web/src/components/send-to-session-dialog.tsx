import { useEffect, useId, useState } from "react";
import { ModalOverlay, Modal } from "react-aria-components";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { hubClient as defaultHubClient } from "@/lib/hub-client-instance";
import type { GeneratedImage, HubClient, Machine } from "@/lib/hub-client";
import { opencodeRequest, MachineOfflineError } from "@/lib/opencode-fetch";
import { sessionsPath, sortSessions } from "@/hooks/use-opencode";
import { buildFileParts, fileToDataUrl, MAX_ATTACHMENT_TOTAL_BYTES, type Attachment } from "@/lib/attachments";
import { getErrorMessage, getResponseErrorMessage } from "@/lib/error-message";
import type { Session } from "@opencode-ai/sdk/v2";

interface SendToSessionDialogProps {
  image: GeneratedImage;
  isOpen: boolean;
  onClose: () => void;
  client?: HubClient;
}

const OVERSIZED_MESSAGE = "This image is too large to send into a session -- max 8 MB.";

function extensionFromMime(mime: string): string {
  const subtype = mime.split("/")[1];
  return subtype && /^[a-z0-9]+$/i.test(subtype) ? subtype : "png";
}

// Fetches the image's own raw bytes (same-origin, cookie-authenticated GET,
// same as the <img src> the gallery already uses) rather than trusting any
// size the hub metadata might carry -- the check right below needs to bound
// the ACTUAL bytes about to cross the tunnel, not a cached number.
async function fetchImageBlob(client: HubClient, image: GeneratedImage): Promise<Blob> {
  const res = await fetch(client.imageRawUrl(image.id));
  if (!res.ok) throw new Error(`Failed to read image (${res.status})`);
  return res.blob();
}

async function buildImageAttachment(image: GeneratedImage, blob: Blob): Promise<Attachment> {
  const dataUrl = await fileToDataUrl(blob);
  return {
    id: image.id,
    name: `${image.prompt?.slice(0, 40) || "generated-image"}.${extensionFromMime(image.mime)}`,
    mime: image.mime,
    size: blob.size,
    dataUrl,
  };
}

// Machine + session picker, then a same-shape file-part POST as the
// composer's own attachments (buildFileParts) -- reusing the opencode proxy
// rather than any new hub endpoint, per the plan's Task 3. The 8 MB
// attachment/tunnel cap (MAX_ATTACHMENT_TOTAL_BYTES) is enforced BEFORE the
// image is ever read into a data URL or posted, since a disk image can be
// up to 10MB (images/provider-client.ts's IMAGE_MAX_BYTES) -- larger than
// what the tunnel will actually carry.
export function SendToSessionDialog({
  image,
  isOpen,
  onClose,
  client = defaultHubClient,
}: SendToSessionDialogProps) {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [machinesError, setMachinesError] = useState<string | null>(null);
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);

  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const headingId = useId();

  useEffect(() => {
    if (!isOpen) return;
    setMachines(null);
    setMachinesError(null);
    setSelectedMachineId(null);
    setSessions(null);
    setSessionsError(null);
    setSelectedSessionId(null);
    setSendError(null);
    setSent(false);

    client
      .listMachines()
      .then(setMachines)
      .catch((err) => setMachinesError(getErrorMessage(err) ?? "Failed to load machines."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, client]);

  useEffect(() => {
    if (!selectedMachineId) {
      setSessions(null);
      return;
    }
    const machine = machines?.find((m) => m.id === selectedMachineId);
    if (!machine || !machine.online) return;

    setSessions(null);
    setSessionsError(null);
    setSelectedSessionId(null);

    opencodeRequest(selectedMachineId, sessionsPath(machine.connectDirectory), undefined, client)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load sessions (${res.status})`);
        const data = (await res.json()) as Session[];
        setSessions(Array.isArray(data) ? sortSessions(data) : []);
      })
      .catch((err) => {
        const message =
          err instanceof MachineOfflineError
            ? err.message
            : getErrorMessage(err) ?? "Failed to load sessions.";
        setSessionsError(message);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMachineId, machines, client]);

  const selectedMachine = machines?.find((m) => m.id === selectedMachineId) ?? null;

  async function handleSend() {
    if (!selectedMachineId || !selectedSessionId || sending) return;

    setSending(true);
    setSendError(null);
    try {
      const blob = await fetchImageBlob(client, image);
      // BLOCK before ever building the file part or reaching the proxy --
      // exactly the "before sending" ordering the plan requires.
      if (blob.size > MAX_ATTACHMENT_TOTAL_BYTES) {
        setSendError(OVERSIZED_MESSAGE);
        return;
      }

      const attachment = await buildImageAttachment(image, blob);
      const res = await opencodeRequest(
        selectedMachineId,
        `/session/${selectedSessionId}/message`,
        { method: "POST", body: JSON.stringify({ parts: buildFileParts([attachment]) }) },
        client,
      );
      if (!res.ok) {
        throw new Error(await getResponseErrorMessage(res, `Failed to send (${res.status})`));
      }
      setSent(true);
    } catch (err) {
      setSendError(
        err instanceof MachineOfflineError
          ? err.message
          : getErrorMessage(err) ?? "Failed to send image to session.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <Modal className="w-full max-w-md">
        <Dialog aria-labelledby={headingId} className="rounded-lg border border-border bg-overlay">
          <DialogHeader>
            <h2 id={headingId} className="text-base font-semibold text-fg">
              Send to session
            </h2>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {machinesError && (
              <div role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
                {machinesError}
              </div>
            )}
            {!machinesError && machines === null && (
              <p className="text-sm text-muted-fg">Loading machines...</p>
            )}
            {machines !== null && machines.length === 0 && (
              <p className="text-sm text-muted-fg">No paired machines yet.</p>
            )}
            {machines !== null && machines.length > 0 && (
              <div className="space-y-1">
                <Label htmlFor="send-to-session-machine">Machine</Label>
                <select
                  id="send-to-session-machine"
                  aria-label="Machine"
                  className="w-full rounded-lg border border-input bg-transparent px-3 py-1.5 text-sm"
                  value={selectedMachineId ?? ""}
                  onChange={(event) => setSelectedMachineId(event.target.value || null)}
                >
                  <option value="" disabled>
                    Choose a machine
                  </option>
                  {machines.map((machine) => (
                    <option key={machine.id} value={machine.id} disabled={!machine.online}>
                      {machine.name}
                      {!machine.online && " (offline)"}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {selectedMachine && !selectedMachine.online && (
              <div role="alert" className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-fg">
                {selectedMachine.name} is offline. Run <code>mando</code> on it to reconnect.
              </div>
            )}

            {selectedMachine?.online && sessionsError && (
              <div role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
                {sessionsError}
              </div>
            )}
            {selectedMachine?.online && !sessionsError && sessions === null && (
              <p className="text-sm text-muted-fg">Loading sessions...</p>
            )}
            {selectedMachine?.online && sessions !== null && sessions.length === 0 && (
              <p className="text-sm text-muted-fg">No sessions on this machine yet.</p>
            )}
            {selectedMachine?.online && sessions !== null && sessions.length > 0 && (
              <div className="space-y-1">
                <Label htmlFor="send-to-session-session">Session</Label>
                <select
                  id="send-to-session-session"
                  aria-label="Session"
                  className="w-full rounded-lg border border-input bg-transparent px-3 py-1.5 text-sm"
                  value={selectedSessionId ?? ""}
                  onChange={(event) => setSelectedSessionId(event.target.value || null)}
                >
                  <option value="" disabled>
                    Choose a session
                  </option>
                  {sessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.title || session.id}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {sendError && (
              <div role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
                {sendError}
              </div>
            )}
            {sent && (
              <div role="status" className="rounded-md bg-success-subtle px-3 py-2 text-sm text-success-subtle-fg">
                Sent.
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" intent="plain" onPress={onClose}>
              Close
            </Button>
            <Button
              type="button"
              onPress={handleSend}
              isDisabled={!selectedSessionId || sending || sent}
            >
              {sending ? "Sending..." : "Send"}
            </Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
