import { Button } from "@/components/ui/button";
import { DocumentIcon, XMarkIcon } from "@/components/icons/lucide";
import type { Attachment } from "@/lib/attachments";

interface ComposerAttachmentsProps {
  attachments: Attachment[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}

export function ComposerAttachments({
  attachments,
  onRemove,
  disabled = false,
}: ComposerAttachmentsProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap gap-2" data-testid="composer-attachments">
      {attachments.map((attachment) => {
        const isImage = attachment.mime.startsWith("image/");

        return (
          <div
            key={attachment.id}
            data-testid="composer-attachment-chip"
            className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 py-1 pl-1.5 pr-1 text-xs"
          >
            {isImage ? (
              <img
                src={attachment.dataUrl}
                alt={attachment.name}
                className="size-6 shrink-0 rounded object-cover"
              />
            ) : (
              <DocumentIcon size="14px" className="shrink-0 text-muted-fg" />
            )}
            <span className="max-w-32 truncate text-fg/90">
              {attachment.name}
            </span>
            <Button
              type="button"
              intent="plain"
              size="sq-xs"
              isDisabled={disabled}
              aria-label={`Remove ${attachment.name}`}
              onPress={() => onRemove(attachment.id)}
              className="ml-0.5"
            >
              <XMarkIcon className="size-3" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
