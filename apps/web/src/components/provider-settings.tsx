import { useEffect, useState } from "react";
import { hubClient as defaultHubClient } from "@/lib/hub-client-instance";
import { HubClientError, type HubClient, type Provider } from "@/lib/hub-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { getErrorMessage } from "@/lib/error-message";

interface ProviderSettingsProps {
  client?: HubClient;
}

type LoadState =
  | { status: "loading" }
  | { status: "disabled" }
  | { status: "ready"; provider: Provider }
  | { status: "error"; message: string };

// The literal error code imageRoutes/providerRoutes send for a missing
// MANDO_ENCRYPTION_KEY (503 `{error:"images_disabled"}`) -- not meant to be
// shown verbatim, so it's mapped to this sentence instead.
const IMAGES_DISABLED_MESSAGE =
  "Image generation is disabled on this hub -- ask an administrator to configure MANDO_ENCRYPTION_KEY.";

function isImagesDisabled(err: unknown): boolean {
  return err instanceof HubClientError && err.status === 503;
}

// Base URL + API key + image model for the user's own OpenAI-compatible
// image provider (see docs/superpowers/plans/2026-07-05-image-generation.md).
// The API key field is write-only by construction: GET /api/v1/provider
// never returns the key, only `hasKey`, so this component never has a
// value to show there -- only a placeholder reflecting whether one exists.
export function ProviderSettings({ client = defaultHubClient }: ProviderSettingsProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [imageModel, setImageModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  async function load() {
    setState({ status: "loading" });
    try {
      const provider = await client.getProvider();
      setState({ status: "ready", provider });
      setBaseUrl(provider.baseUrl ?? "");
      setImageModel(provider.imageModel ?? "");
      setApiKey("");
    } catch (err) {
      if (isImagesDisabled(err)) {
        setState({ status: "disabled" });
      } else {
        setState({
          status: "error",
          message: getErrorMessage(err) ?? "Failed to load provider settings.",
        });
      }
    }
  }

  useEffect(() => {
    load();
    // `client` is a stable singleton/prop in practice (see other pages'
    // identical pattern, e.g. images-gallery.tsx) -- re-running on every
    // render would refetch in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (saving || state.status === "loading" || state.status === "disabled") return;

    setSaving(true);
    setFormError(null);
    setSavedMessage(null);
    try {
      await client.setProvider({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        imageModel: imageModel.trim() || null,
      });
      setSavedMessage("Provider settings saved.");
      await load();
    } catch (err) {
      setFormError(
        isImagesDisabled(err)
          ? IMAGES_DISABLED_MESSAGE
          : getErrorMessage(err) ?? "Failed to save provider settings.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (saving) return;

    setSaving(true);
    setFormError(null);
    setSavedMessage(null);
    try {
      await client.deleteProvider();
      setBaseUrl("");
      setApiKey("");
      setImageModel("");
      setSavedMessage("Provider settings cleared.");
      await load();
    } catch (err) {
      setFormError(
        isImagesDisabled(err)
          ? IMAGES_DISABLED_MESSAGE
          : getErrorMessage(err) ?? "Failed to clear provider settings.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (state.status === "loading") {
    return <p className="text-sm text-muted-fg">Loading provider settings...</p>;
  }

  if (state.status === "disabled") {
    return (
      <div
        role="alert"
        className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-fg"
      >
        {IMAGES_DISABLED_MESSAGE}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
        {state.message}
      </div>
    );
  }

  const { provider } = state;

  return (
    <form onSubmit={handleSave} aria-label="Provider settings" className="max-w-sm space-y-6">
      <div className="space-y-1">
        <Label htmlFor="provider-base-url">Base URL</Label>
        <Input
          id="provider-base-url"
          name="baseUrl"
          type="url"
          placeholder="https://api.example.com/v1"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          required
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="provider-api-key">API key</Label>
        <Input
          id="provider-api-key"
          name="apiKey"
          type="password"
          placeholder={provider.hasKey ? "configured — leave blank to keep" : "sk-..."}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <p className="text-xs text-muted-fg">
          {provider.hasKey
            ? "A key is configured. Leave this blank to keep it, or enter a new one to replace it."
            : "Encrypted at rest and never shown again once saved."}
        </p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="provider-image-model">Image model</Label>
        <Input
          id="provider-image-model"
          name="imageModel"
          placeholder="flux-2-klein"
          value={imageModel}
          onChange={(event) => setImageModel(event.target.value)}
        />
      </div>

      {formError && (
        <div role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
          {formError}
        </div>
      )}

      {savedMessage && (
        <div role="status" className="rounded-md bg-success-subtle px-3 py-2 text-sm text-success-subtle-fg">
          {savedMessage}
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" isDisabled={saving || !baseUrl.trim()}>
          {saving ? "Saving..." : "Save"}
        </Button>
        <Button
          type="button"
          intent="outline"
          onPress={handleClear}
          isDisabled={saving || !provider.baseUrl}
        >
          Clear
        </Button>
      </div>
    </form>
  );
}
