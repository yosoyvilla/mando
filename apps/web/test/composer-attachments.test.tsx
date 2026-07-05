import { describe, it, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ComposerAttachments } from "../src/components/composer-attachments";
import { filesFromFileList, type Attachment } from "../src/lib/attachments";

const imageAttachment: Attachment = {
  id: "img-1",
  name: "screenshot.png",
  mime: "image/png",
  size: 1024,
  dataUrl: "data:image/png;base64,AA==",
};

const pdfAttachment: Attachment = {
  id: "pdf-1",
  name: "report.pdf",
  mime: "application/pdf",
  size: 2048,
  dataUrl: "data:application/pdf;base64,BB==",
};

describe("ComposerAttachments", () => {
  it("renders nothing when there are no attachments", () => {
    render(<ComposerAttachments attachments={[]} onRemove={() => {}} />);
    expect(screen.queryByTestId("composer-attachments")).toBeNull();
  });

  it("renders a thumbnail chip for image attachments", () => {
    render(
      <ComposerAttachments attachments={[imageAttachment]} onRemove={() => {}} />,
    );
    const img = screen.getByAltText("screenshot.png") as HTMLImageElement;
    expect(img.src).toBe(imageAttachment.dataUrl);
    expect(screen.getByText("screenshot.png")).toBeTruthy();
  });

  it("renders a labeled chip (no image) for pdf attachments", () => {
    render(
      <ComposerAttachments attachments={[pdfAttachment]} onRemove={() => {}} />,
    );
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.queryByAltText("report.pdf")).toBeNull();
  });

  it("exposes a remove button labeled with the filename", () => {
    render(
      <ComposerAttachments attachments={[imageAttachment]} onRemove={() => {}} />,
    );
    expect(
      screen.getByRole("button", { name: "Remove screenshot.png" }),
    ).toBeTruthy();
  });

  it("calls onRemove with the attachment id when the remove button is pressed", () => {
    const onRemove = mock((_id: string) => {});
    render(
      <ComposerAttachments attachments={[imageAttachment]} onRemove={onRemove} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove screenshot.png" }));

    expect(onRemove).toHaveBeenCalledWith("img-1");
  });

  it("renders multiple chips independently", () => {
    render(
      <ComposerAttachments
        attachments={[imageAttachment, pdfAttachment]}
        onRemove={() => {}}
      />,
    );
    expect(screen.getAllByTestId("composer-attachment-chip")).toHaveLength(2);
  });
});

// The composer (routes/_app/session/$id.tsx) wires paste-on-textarea and
// drop-on-container to `filesFromFileList(event.clipboardData?.files)` /
// `filesFromFileList(event.dataTransfer.files)`. Rendering the full session
// route isn't practical here (it needs the router, SWR, and store
// providers), so this exercises the same extraction against a minimal
// harness wired the same way, via real DOM paste/drop events.
function PasteDropHarness({
  onFiles,
}: {
  onFiles: (files: File[]) => void;
}) {
  return (
    <div
      data-testid="drop-zone"
      onDrop={(e) => {
        e.preventDefault();
        onFiles(filesFromFileList(e.dataTransfer.files));
      }}
    >
      <textarea
        data-testid="paste-target"
        onPaste={(e) => {
          const files = filesFromFileList(e.clipboardData?.files);
          if (files.length > 0) {
            e.preventDefault();
            onFiles(files);
          }
        }}
      />
    </div>
  );
}

describe("composer paste/drop wiring", () => {
  it("extracts files from a paste event's clipboardData", () => {
    const onFiles = mock((_files: File[]) => {});
    render(<PasteDropHarness onFiles={onFiles} />);

    const file = new File(["a"], "pasted.png", { type: "image/png" });
    fireEvent.paste(screen.getByTestId("paste-target"), {
      clipboardData: { files: [file] },
    });

    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it("ignores a paste event with no files", () => {
    const onFiles = mock((_files: File[]) => {});
    render(<PasteDropHarness onFiles={onFiles} />);

    fireEvent.paste(screen.getByTestId("paste-target"), {
      clipboardData: { files: [] },
    });

    expect(onFiles).not.toHaveBeenCalled();
  });

  it("extracts files from a drop event's dataTransfer", () => {
    const onFiles = mock((_files: File[]) => {});
    render(<PasteDropHarness onFiles={onFiles} />);

    const file = new File(["a"], "dropped.pdf", { type: "application/pdf" });
    fireEvent.drop(screen.getByTestId("drop-zone"), {
      dataTransfer: { files: [file] },
    });

    expect(onFiles).toHaveBeenCalledWith([file]);
  });
});
