import { DocumentIcon } from "@/components/icons/lucide";
import type { FilePart } from "@/hooks/use-session-messages";

interface AttachedFilesProps {
  parts: FilePart[];
}

// A file part's `url` is whatever some client wrote into opencode's session
// store, which is untrusted from this UI's perspective: another paired
// machine, the raw API, or a crafted session could set it to
// `data:text/html,<script>...` or `javascript:...`, which would execute if
// we put it in an `<a href target="_blank">` and the user clicked. So we
// only ever surface a url whose scheme we trust for the way we use it:
// - `<a href>` (opens as a document): http(s) and blob only. A malicious
//   `data:`/`javascript:` link is dropped -- the file renders as inert text.
// - `<img src>` (rendered, never navigated): additionally allow
//   `data:image/*`, since that is exactly how the composer attaches images
//   and an image data URL cannot execute script in an <img>.
function safeLinkHref(url: string): string | undefined {
  try {
    // File-part urls are always absolute (data:/http(s):/blob:), so no base
    // is needed -- and not depending on window keeps this pure/testable.
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "blob:") {
      return u.toString();
    }
  } catch {
    // Not a parseable absolute URL -- treat as unsafe.
  }
  return undefined;
}

function safeImageSrc(url: string): string | undefined {
  const linkSafe = safeLinkHref(url);
  if (linkSafe) return linkSafe;
  // A data:image/* URL is safe as an <img src> (rendered, not navigated).
  if (/^data:image\/[a-z0-9.+-]+;/i.test(url)) return url;
  return undefined;
}

// Returns the url only if it is a data: URL whose declared media type equals
// the part's mime -- used for `download` links, where a mismatched type
// (e.g. a text/html payload sitting in a part labeled application/pdf) is
// refused. The `download` attribute itself prevents execution regardless;
// this is defense in depth against a mislabeled part.
function safeDataDownload(url: string, mime: string): string | undefined {
  const match = /^data:([a-z0-9.+/-]+)[;,]/i.exec(url);
  if (match && match[1].toLowerCase() === mime.toLowerCase()) return url;
  return undefined;
}

// Renders file parts attached to a session message. Works for messages
// from ANY client -- opencode's file-part schema is {mime, filename, url}
// regardless of which client attached the file, so this isn't specific to
// the mando composer.
export function AttachedFiles({ parts }: AttachedFilesProps) {
  if (parts.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2" data-testid="attached-files">
      {parts.map((part) => {
        if (part.mime.startsWith("image/")) {
          const src = safeImageSrc(part.url);
          const href = safeLinkHref(part.url);
          const img = (
            <img
              src={src}
              alt={part.filename || "Attached image"}
              className="max-h-64 rounded-md border border-border object-contain"
            />
          );
          if (!src) {
            // Nothing safe to show -- surface the filename as inert text
            // rather than a broken image or a dangerous link.
            return (
              <span
                key={part.id}
                data-testid="attached-file-unsafe"
                className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-fg"
              >
                {part.filename || part.mime}
              </span>
            );
          }
          // Only wrap in an opening link when the href scheme is also safe;
          // a data:image is fine to show but not to navigate to.
          return href ? (
            <a
              key={part.id}
              href={href}
              target="_blank"
              rel="noreferrer"
              data-testid="attached-file-image"
            >
              {img}
            </a>
          ) : (
            <span key={part.id} data-testid="attached-file-image">
              {img}
            </span>
          );
        }

        const isPdf = part.mime === "application/pdf";
        const testId = isPdf ? "attached-file-pdf" : "attached-file-generic";
        const label = (
          <>
            <DocumentIcon size="14px" className="shrink-0 text-muted-fg" />
            <span className="max-w-40 truncate">
              {part.filename || part.mime}
            </span>
          </>
        );
        const className =
          "flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-fg/90";

        // A hosted file (http/https/blob) opens in a new tab.
        const openHref = safeLinkHref(part.url);
        if (openHref) {
          return (
            <a
              key={part.id}
              href={openHref}
              target="_blank"
              rel="noreferrer"
              data-testid={testId}
              className={`${className} hover:border-fg/30`}
            >
              {label}
            </a>
          );
        }
        // A file attached as a data: URL (what the composer produces) is
        // offered as a DOWNLOAD, never a navigation: `download` forces a save
        // instead of opening the URL as a document, so a `data:text/html` or
        // `data:image/svg+xml` payload can't execute, and it also sidesteps
        // the browser block on top-level data: navigation. Only allow it when
        // the data URL's declared type matches this part's mime, so a
        // text/html payload mislabeled as a PDF part is still refused.
        const dataHref = safeDataDownload(part.url, part.mime);
        if (dataHref) {
          return (
            <a
              key={part.id}
              href={dataHref}
              download={part.filename || (isPdf ? "attachment.pdf" : "attachment")}
              data-testid={testId}
              className={`${className} hover:border-fg/30`}
            >
              {label}
            </a>
          );
        }
        // Nothing safe to link -- inert text.
        return (
          <span
            key={part.id}
            data-testid={testId}
            className={`${className} text-muted-fg`}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}
