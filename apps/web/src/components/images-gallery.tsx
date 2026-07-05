import { useEffect, useRef, useState } from "react";
import { hubClient as defaultHubClient } from "@/lib/hub-client-instance";
import { HubClientError, type GeneratedImage, type HubClient } from "@/lib/hub-client";
import { validate as validateAttachment } from "@/lib/attachments";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/field";
import { Link } from "@/components/ui/link";
import { ArrowPathIcon, IconPen, SendIcon, TrashIcon } from "@/components/icons/lucide";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { getErrorMessage } from "@/lib/error-message";
import { useEditSourceStore } from "@/stores/edit-source-store";
import { SendToSessionDialog } from "@/components/send-to-session-dialog";

interface ImagesGalleryProps {
  client?: HubClient;
}

// The edit form's source image can come from three places: a freshly
// attached local file (the original flow), an existing gallery item
// (Task 3: edit-from-gallery, via imageRoutes' sourceImageId branch -- no
// re-upload needed), or a data URL handed off from a session message
// (Task 3: session-image -> edit-in-Images, via edit-source-store.ts).
type EditSource =
  | { kind: "file"; file: File }
  | { kind: "existing"; image: GeneratedImage }
  | { kind: "dataUrl"; dataUrl: string; mime: string; filename: string };

function editSourceLabel(source: EditSource): string {
  if (source.kind === "file") return source.file.name;
  if (source.kind === "existing") return source.image.prompt ?? source.image.id;
  return source.filename;
}

// Turns a data: URL (session hand-off) into a File the same `editImage({
// image })` multipart path already accepts -- `fetch()` can read a data:
// URL directly, so no manual base64 decoding is needed here.
async function dataUrlToFile(dataUrl: string, mime: string, filename: string): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], filename, { type: mime });
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

// "Count": how many images a single Generate submits for -- the hub loops
// the provider call this many times and stores each (imageRoutes'
// clampImageCount clamps 1..4 server-side too; this list is just the UI's
// offered range, kept in sync with that same 1..4 bound).
const COUNT_OPTIONS = ["1", "2", "3", "4"];

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
  const [count, setCount] = useState<string | null>("1");
  const [generating, setGenerating] = useState(false);
  const [generateNotice, setGenerateNotice] = useState<Notice | null>(null);

  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [regenerateNotice, setRegenerateNotice] = useState<Notice | null>(null);

  const [editSource, setEditSource] = useState<EditSource | null>(null);
  const [editPrompt, setEditPrompt] = useState("");
  const [editing, setEditing] = useState(false);
  const [editNotice, setEditNotice] = useState<Notice | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState<GeneratedImage | null>(null);
  const [sendTarget, setSendTarget] = useState<GeneratedImage | null>(null);

  const consumePendingEditSource = useEditSourceStore((s) => s.consumePendingEditSource);

  // Task 3: session-image -> edit-in-Images. Runs once on mount -- the
  // store's consume-and-clear semantics mean a later remount (e.g.
  // navigating away and back) won't re-apply a stale hand-off.
  useEffect(() => {
    const pending = consumePendingEditSource();
    if (pending) {
      setEditSource({ kind: "dataUrl", ...pending });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  function addImages(newImages: GeneratedImage[]) {
    setState((current) => ({
      status: "ready",
      images: [...newImages, ...(current.status === "ready" ? current.images : [])],
    }));
  }

  function resolvedSize(): string | undefined {
    return size && size !== "auto" ? size : undefined;
  }

  function resolvedCount(): number {
    return count ? Number(count) : 1;
  }

  async function handleGenerate(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || generating) return;

    setGenerating(true);
    setGenerateNotice(null);
    try {
      const images = await client.generateImage({
        prompt: trimmed,
        size: resolvedSize(),
        n: resolvedCount(),
      });
      addImages(images);
      setPrompt("");
    } catch (err) {
      setGenerateNotice(noticeFromError(err, "Failed to generate image."));
    } finally {
      setGenerating(false);
    }
  }

  // Regenerate: re-submits a single gallery item's own prompt as a brand
  // new (independent) generation -- always exactly one image, regardless
  // of the main form's current count selector, since "regenerate this one"
  // is a distinct action from "generate a fresh batch." Uses the form's
  // current size selection, since a stored image doesn't carry its own
  // size back from the provider.
  async function handleRegenerate(image: GeneratedImage) {
    const trimmed = image.prompt?.trim();
    if (!trimmed || regeneratingId) return;

    setRegeneratingId(image.id);
    setRegenerateNotice(null);
    try {
      const images = await client.generateImage({ prompt: trimmed, size: resolvedSize() });
      addImages(images);
    } catch (err) {
      setRegenerateNotice(noticeFromError(err, "Failed to regenerate image."));
    } finally {
      setRegeneratingId(null);
    }
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setEditSource(null);
      return;
    }

    const result = validateAttachment(file, []);
    if (!result.ok) {
      setEditNotice({ kind: "error", message: result.error });
      setEditSource(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setEditNotice(null);
    setEditSource({ kind: "file", file });
  }

  // Edit-from-gallery (Task 3): reuse an existing image as the edit source
  // instead of re-uploading it -- imageRoutes' POST /images/edits already
  // accepts {sourceImageId, prompt, size} as a JSON alternative to the
  // multipart {image} upload.
  function handleEditFromGallery(image: GeneratedImage) {
    setEditNotice(null);
    setEditSource({ kind: "existing", image });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function clearEditSource() {
    setEditSource(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleEdit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = editPrompt.trim();
    if (!trimmed || !editSource || editing) return;

    setEditing(true);
    setEditNotice(null);
    try {
      const image =
        editSource.kind === "file"
          ? await client.editImage({ prompt: trimmed, size: resolvedSize(), image: editSource.file })
          : editSource.kind === "existing"
            ? await client.editImage({
                prompt: trimmed,
                size: resolvedSize(),
                sourceImageId: editSource.image.id,
              })
            : await client.editImage({
                prompt: trimmed,
                size: resolvedSize(),
                image: await dataUrlToFile(editSource.dataUrl, editSource.mime, editSource.filename),
              });
      addImages([image]);
      setEditPrompt("");
      clearEditSource();
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
          <div className="w-28 space-y-1">
            <span className="select-none text-base/6 text-fg sm:text-sm/6">Count</span>
            <Select
              aria-label="Count"
              value={count}
              onChange={(value) => setCount(value ? String(value) : null)}
              placeholder="1"
            >
              <SelectTrigger />
              <SelectContent>
                {COUNT_OPTIONS.map((option) => (
                  <SelectItem key={option} id={option} textValue={option}>
                    {option}
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
        {editSource && editSource.kind !== "file" && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/25 px-3 py-2 text-sm text-fg/90">
            <span className="truncate">Editing: {editSourceLabel(editSource)}</span>
            <Button type="button" size="xs" intent="plain" onPress={clearEditSource}>
              Clear
            </Button>
          </div>
        )}
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
        <Button type="submit" isDisabled={editing || !editSource || !editPrompt.trim()}>
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
                <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                  {image.prompt && (
                    <Button
                      type="button"
                      size="sq-xs"
                      intent="secondary"
                      aria-label={`Regenerate image: ${image.prompt}`}
                      onPress={() => handleRegenerate(image)}
                      isDisabled={regeneratingId === image.id}
                    >
                      <ArrowPathIcon className={`size-3.5 ${regeneratingId === image.id ? "animate-spin" : ""}`} />
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sq-xs"
                    intent="secondary"
                    aria-label={`Edit image: ${image.prompt ?? image.id}`}
                    onPress={() => handleEditFromGallery(image)}
                  >
                    <IconPen className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="sq-xs"
                    intent="secondary"
                    aria-label={`Send to session: ${image.prompt ?? image.id}`}
                    onPress={() => setSendTarget(image)}
                  >
                    <SendIcon className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="sq-xs"
                    intent="danger"
                    aria-label={`Delete image: ${image.prompt ?? image.id}`}
                    onPress={() => handleDelete(image.id)}
                    isDisabled={deletingId === image.id}
                  >
                    <TrashIcon className="size-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {regenerateNotice && <div className="mt-3"><NoticeBanner notice={regenerateNotice} /></div>}
      </div>

      {sendTarget && (
        <SendToSessionDialog
          image={sendTarget}
          isOpen={!!sendTarget}
          onClose={() => setSendTarget(null)}
          client={client}
        />
      )}

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
