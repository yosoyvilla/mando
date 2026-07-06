import { useEffect, useState } from "react";
import { hubClient as defaultHubClient } from "@/lib/hub-client-instance";
import { HubClientError, type HubClient, type Provider, type ProviderModel } from "@/lib/hub-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { getErrorMessage } from "@/lib/error-message";

// Substrings/prefixes that mark a model id as not chat-capable (per the
// plan's Task 4 filter list): embedding, transcription (whisper), TTS
// (kokoro), and reranker models never accept a chat/completions request,
// and image models (flux and its variants) are a completely different
// modality. This is a client-side convenience filter for the picker only
// -- GET /api/v1/provider/models still returns the provider's raw,
// unfiltered list, and the free-text chatModel field below always accepts
// any id regardless of this filter.
const NON_CHAT_SUBSTRINGS = ["embedding", "whisper", "kokoro", "rerank"];

function isChatCapableModelId(id: string): boolean {
  const lower = id.toLowerCase();
  if (lower.startsWith("flux")) return false;
  return !NON_CHAT_SUBSTRINGS.some((needle) => lower.includes(needle));
}

type ModelsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; ids: string[] }
  | { status: "error" };

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
  const [chatModel, setChatModel] = useState("");
  const [modelsState, setModelsState] = useState<ModelsState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  async function loadModels() {
    setModelsState({ status: "loading" });
    try {
      const models = await client.listProviderModels();
      const ids = models.map((m: ProviderModel) => m.id).filter(isChatCapableModelId);
      setModelsState({ status: "ready", ids });
    } catch {
      // Any failure here (no provider configured yet, provider
      // unreachable, SSRF-guard rejection, etc.) just means the picker
      // convenience isn't available -- the chatModel field above is
      // already a plain, always-usable free-text input, so this
      // degrades gracefully rather than blocking the form.
      setModelsState({ status: "error" });
    }
  }

  async function load() {
    setState({ status: "loading" });
    try {
      const provider = await client.getProvider();
      setState({ status: "ready", provider });
      setBaseUrl(provider.baseUrl ?? "");
      setImageModel(provider.imageModel ?? "");
      setChatModel(provider.chatModel ?? "");
      setApiKey("");
      // The model list can only come from an already-configured provider
      // (GET /api/v1/provider/models 400s otherwise) -- skip the call
      // entirely rather than surfacing that as a picker-level error.
      if (provider.baseUrl) {
        await loadModels();
      } else {
        setModelsState({ status: "idle" });
      }
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
        chatModel: chatModel.trim() || null,
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
      setChatModel("");
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

      <div className="space-y-1">
        <Label htmlFor="provider-chat-model">Chat model</Label>
        <Input
          id="provider-chat-model"
          name="chatModel"
          placeholder="gpt-4o-mini"
          value={chatModel}
          onChange={(event) => setChatModel(event.target.value)}
        />
        {modelsState.status === "ready" && (
          <>
            <Label htmlFor="provider-chat-model-picker">Pick from provider's models</Label>
            <select
              id="provider-chat-model-picker"
              aria-label="Pick from provider's models"
              className="w-full rounded-lg border border-input bg-transparent px-3 py-1.5 text-sm"
              value=""
              onChange={(event) => {
                if (event.target.value) setChatModel(event.target.value);
              }}
            >
              <option value="">Select a model...</option>
              {modelsState.ids.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </>
        )}
        {modelsState.status === "error" && (
          <p className="text-xs text-muted-fg">
            Couldn't fetch the provider's model list -- enter a chat model id above.
          </p>
        )}
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
