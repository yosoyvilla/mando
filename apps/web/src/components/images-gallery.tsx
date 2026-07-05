import { useEffect, useRef, useState } from "react";
import { hubClient as defaultHubClient } from "@/lib/hub-client-instance";
import { HubClientError, type GeneratedImage, type HubClient } from "@/lib/hub-client";
import { validate as validateAttachment } from "@/lib/attachments";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/field";
import { Link } from "@/components/ui/link";
import { TrashIcon } from "@/components/icons/lucide";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { getErrorMessage } from "@/lib/error-message";

interface ImagesGalleryProps {
  client?: HubClient;
}

type GalleryState =
  | { status: "loading" }
  | { status: "ready"; images: GeneratedImage[] }
  | { status: "error"; message: string };

// Same "code, not a sentence" shape as provider-settings.tsx's
// IMAGES_DISABLED_MESSAGE -- imageRoutes sends these two literal strings,
// never free text, so both are matched exactly and mapped to a full
// sentence rather than shown as-is.
const PROVIDER_NOT_CONFIGURED = "provider_not_configured";
const IMAGES_DISABLED_MESSAGE =
  "Image generation is disabled on this hub -- ask an administrator to configure MANDO_ENCRYPTION_KEY.";

const SIZE_OPTIONS = [
  { id: "auto", title: "Auto" },
  { id: "1024x1024", title: "Square (1024x1024)" },
  { id: "1024x1792", title: "Portrait (1024x1792)" },
  { id: "1792x1024", title: "Landscape (1792x1024)" },
];

function isProviderNotConfigured(err: unknown): boolean {
  return err instanceof HubClientError && err.status === 400 && err.message === PROVIDER_NOT_CONFIGURED;
}

function isImagesDisabled(err: unknown): boolean {
  return err instanceof HubClientError && err.status === 503;
}

type Notice = { kind: "provider" | "error"; message: string };

function noticeFromError(err: unknown, fallback: string): Notice {
  if (isProviderNotConfigured(err)) {
    return { kind: "provider", message: "Set up a provider in Settings first." };
  }
  if (isImagesDisabled(err)) {
    return { kind: "error", message: IMAGES_DISABLED_MESSAGE };
  }
  return { kind: "error", message: getErrorMessage(err) ?? fallback };
}

function NoticeBanner({ notice }: { notice: Notice }) {
  if (notice.kind === "provider") {
    return (
      <div role="alert" className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-fg">
        {notice.message} <Link href="/settings">Go to Settings</Link>
      </div>
    );
  }
  return (
    <div role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
      {notice.message}
    </div>
  );
}

// Standalone "Images" section: generate/edit images through the user's own
// provider (configured on the Settings page) and browse/delete what's been
// generated. User-scoped and independent of any paired machine -- this
// component never touches useMachineStore or an opencode proxy.
export function ImagesGallery({ client = defaultHubClient }: ImagesGalleryProps) {
  const [state, setState] = useState<GalleryState>({ status: "loading" });

  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<string | null>("auto");
  const [generating, setGenerating] = useState(false);
  const [generateNotice, setGenerateNotice] = useState<Notice | null>(null);

  const [editFile, setEditFile] = useState<File | null>(null);
  const [editPrompt, setEditPrompt] = useState("");
  const [editing, setEditing] = useState(false);
  const [editNotice, setEditNotice] = useState<Notice | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState<GeneratedImage | null>(null);

  async function load() {
    setState({ status: "loading" });
    try {
      const images = await client.listImages();
      setState({ status: "ready", images });
    } catch (err) {
      setState({ status: "error", message: getErrorMessage(err) ?? "Failed to load images." });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  function addImage(image: GeneratedImage) {
    setState((current) => ({
      status: "ready",
      images: [image, ...(current.status === "ready" ? current.images : [])],
    }));
  }

  function resolvedSize(): string | undefined {
    return size && size !== "auto" ? size : undefined;
  }

  async function handleGenerate(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || generating) return;

    setGenerating(true);
    setGenerateNotice(null);
    try {
      const image = await client.generateImage({ prompt: trimmed, size: resolvedSize() });
      addImage(image);
      setPrompt("");
    } catch (err) {
      setGenerateNotice(noticeFromError(err, "Failed to generate image."));
    } finally {
      setGenerating(false);
    }
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setEditFile(null);
      return;
    }

    const result = validateAttachment(file, []);
    if (!result.ok) {
      setEditNotice({ kind: "error", message: result.error });
      setEditFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setEditNotice(null);
    setEditFile(file);
  }

  async function handleEdit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = editPrompt.trim();
    if (!trimmed || !editFile || editing) return;

    setEditing(true);
    setEditNotice(null);
    try {
      const image = await client.editImage({ prompt: trimmed, size: resolvedSize(), image: editFile });
      addImage(image);
      setEditPrompt("");
      setEditFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setEditNotice(noticeFromError(err, "Failed to edit image."));
    } finally {
      setEditing(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await client.deleteImage(id);
      setState((current) =>
        current.status === "ready"
          ? { status: "ready", images: current.images.filter((image) => image.id !== id) }
          : current,
      );
      setEnlarged((current) => (current?.id === id ? null : current));
    } catch (err) {
      console.error("Failed to delete image:", err);
    } finally {
      setDeletingId(null);
    }
  }

  const images = state.status === "ready" ? state.images : [];

  return (
    <div className="space-y-8">
      <form onSubmit={handleGenerate} aria-label="Generate an image" className="max-w-xl space-y-3">
        <div className="space-y-1">
          <Label htmlFor="images-prompt">Prompt</Label>
          <Textarea
            id="images-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the image you want to generate..."
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-52 space-y-1">
            {/* `Select` (react-aria-components) isn't a native form control
                that a plain `<label htmlFor>` can associate with -- it needs
                its own `aria-label` instead. The visible span is kept for
                sighted users, matching the field-caption look used
                elsewhere (e.g. provider-settings.tsx's `<Label>`). */}
            <span className="select-none text-base/6 text-fg sm:text-sm/6">Size</span>
            <Select
              aria-label="Size"
              value={size}
              onChange={(value) => setSize(value ? String(value) : null)}
              placeholder="Auto"
            >
              <SelectTrigger />
              <SelectContent>
                {SIZE_OPTIONS.map((option) => (
                  <SelectItem key={option.id} id={option.id} textValue={option.title}>
                    {option.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" isDisabled={generating || !prompt.trim()}>
            {generating ? "Generating..." : "Generate"}
          </Button>
        </div>
        {generateNotice && <NoticeBanner notice={generateNotice} />}
      </form>

      <form
        onSubmit={handleEdit}
        aria-label="Edit an image"
        className="max-w-xl space-y-3 border-t border-border pt-6"
      >
        <h2 className="text-sm font-medium">Edit an image</h2>
        <div className="space-y-1">
          <Label htmlFor="images-edit-file">Source image</Label>
          <input
            ref={fileInputRef}
            id="images-edit-file"
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="block text-sm text-fg"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="images-edit-prompt">Edit prompt</Label>
          <Textarea
            id="images-edit-prompt"
            value={editPrompt}
            onChange={(event) => setEditPrompt(event.target.value)}
            placeholder="Describe how to edit the attached image..."
          />
        </div>
        <Button type="submit" isDisabled={editing || !editFile || !editPrompt.trim()}>
          {editing ? "Editing..." : "Edit"}
        </Button>
        {editNotice && <NoticeBanner notice={editNotice} />}
      </form>

      <div>
        <h2 className="mb-3 text-sm font-medium">Gallery</h2>

        {state.status === "loading" && (
          <p className="text-sm text-muted-fg">Loading images...</p>
        )}

        {state.status === "error" && (
          <div role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
            {state.message}
          </div>
        )}

        {state.status === "ready" && images.length === 0 && (
          <p className="text-sm text-muted-fg">
            No images yet. Generate one above to get started.
          </p>
        )}

        {state.status === "ready" && images.length > 0 && (
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {images.map((image) => (
              <li key={image.id} className="group relative">
                <button
                  type="button"
                  onClick={() => setEnlarged(image)}
                  className="block w-full overflow-hidden rounded-lg border border-border"
                  aria-label={`Enlarge image: ${image.prompt ?? image.id}`}
                >
                  <img
                    src={client.imageRawUrl(image.id)}
                    alt={image.prompt ?? "Generated image"}
                    className="aspect-square w-full object-cover"
                  />
                </button>
                <Button
                  type="button"
                  size="sq-xs"
                  intent="danger"
                  aria-label={`Delete image: ${image.prompt ?? image.id}`}
                  onPress={() => handleDelete(image.id)}
                  isDisabled={deletingId === image.id}
                  className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus:opacity-100"
                >
                  <TrashIcon className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {enlarged && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Enlarged image"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setEnlarged(null)}
        >
          <img
            src={client.imageRawUrl(enlarged.id)}
            alt={enlarged.prompt ?? "Generated image"}
            className="max-h-full max-w-full rounded-lg"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
