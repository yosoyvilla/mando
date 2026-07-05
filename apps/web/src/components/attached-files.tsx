import { DocumentIcon } from "@/components/icons/lucide";
import type { FilePart } from "@/hooks/use-session-messages";

interface AttachedFilesProps {
  parts: FilePart[];
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
          return (
            <a
              key={part.id}
              href={part.url}
              target="_blank"
              rel="noreferrer"
              data-testid="attached-file-image"
            >
              <img
                src={part.url}
                alt={part.filename || "Attached image"}
                className="max-h-64 rounded-md border border-border object-contain"
              />
            </a>
          );
        }

        const isPdf = part.mime === "application/pdf";
        return (
          <a
            key={part.id}
            href={part.url}
            target="_blank"
            rel="noreferrer"
            data-testid={isPdf ? "attached-file-pdf" : "attached-file-generic"}
            className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-fg/90 hover:border-fg/30"
          >
            <DocumentIcon size="14px" className="shrink-0 text-muted-fg" />
            <span className="max-w-40 truncate">
              {part.filename || part.mime}
            </span>
          </a>
        );
      })}
    </div>
  );
}
