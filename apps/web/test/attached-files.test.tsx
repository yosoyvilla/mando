import { describe, it, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AttachedFiles } from "../src/components/attached-files";
import type { FilePart } from "../src/hooks/use-session-messages";

function makeFilePart(overrides: Partial<FilePart>): FilePart {
  return {
    id: "part_1",
    sessionID: "s1",
    messageID: "msg_1",
    type: "file",
    mime: "image/png",
    filename: "a.png",
    url: "data:image/png;base64,AA==",
    ...overrides,
  };
}

describe("AttachedFiles", () => {
  it("renders nothing for an empty parts list", () => {
    render(<AttachedFiles parts={[]} />);
    expect(screen.queryByTestId("attached-files")).toBeNull();
  });

  it("renders an image data URL inline but does not wrap it in a navigable link", () => {
    // data:image is safe as an <img src> (rendered, not navigated) but a
    // top-level navigation to it is refused, so there is no wrapping <a>.
    const part = makeFilePart({
      mime: "image/png",
      filename: "screenshot.png",
      url: "data:image/png;base64,AAAA",
    });
    render(<AttachedFiles parts={[part]} />);

    const img = screen.getByAltText("screenshot.png") as HTMLImageElement;
    expect(img.src).toBe("data:image/png;base64,AAAA");
    expect(screen.getByTestId("attached-file-image").tagName).toBe("SPAN");
  });

  it("wraps a hosted image in a new-tab link", () => {
    const part = makeFilePart({
      mime: "image/png",
      filename: "shot.png",
      url: "https://example.com/shot.png",
    });
    render(<AttachedFiles parts={[part]} />);
    const link = screen.getByTestId("attached-file-image") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.href).toBe("https://example.com/shot.png");
    expect(link.target).toBe("_blank");
  });

  it("offers a pdf data URL as a download, not a navigation", () => {
    const part = makeFilePart({
      mime: "application/pdf",
      filename: "report.pdf",
      url: "data:application/pdf;base64,BBBB",
    });
    render(<AttachedFiles parts={[part]} />);

    const link = screen.getByTestId("attached-file-pdf") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("download")).toBe("report.pdf");
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("href")).toBe("data:application/pdf;base64,BBBB");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("refuses a javascript: url — renders inert text, no link", () => {
    const part = makeFilePart({
      mime: "application/pdf",
      filename: "evil.pdf",
      url: "javascript:alert(1)",
    });
    render(<AttachedFiles parts={[part]} />);
    const el = screen.getByTestId("attached-file-pdf");
    expect(el.tagName).toBe("SPAN");
    expect(el.querySelector("a")).toBeNull();
  });

  it("refuses a data:text/html payload mislabeled as a pdf part", () => {
    const part = makeFilePart({
      mime: "application/pdf",
      filename: "x.pdf",
      url: "data:text/html;base64,PHNjcmlwdD4=",
    });
    render(<AttachedFiles parts={[part]} />);
    const el = screen.getByTestId("attached-file-pdf");
    expect(el.tagName).toBe("SPAN");
  });

  it("refuses a data:image/svg+xml as a navigable image link (renders as span, no href)", () => {
    // svg as <img src> cannot script, so it still renders; but it must never
    // become an <a href> that navigates to the svg document.
    const part = makeFilePart({
      mime: "image/svg+xml",
      filename: "x.svg",
      url: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    });
    render(<AttachedFiles parts={[part]} />);
    expect(screen.getByTestId("attached-file-image").tagName).toBe("SPAN");
  });

  it("renders an unknown mime as a plain chip labeled with the filename", () => {
    const part = makeFilePart({
      mime: "application/octet-stream",
      filename: "data.bin",
      url: "data:application/octet-stream;base64,CCCC",
    });
    render(<AttachedFiles parts={[part]} />);

    expect(screen.getByTestId("attached-file-generic")).toBeTruthy();
    expect(screen.getByText("data.bin")).toBeTruthy();
  });

  it("falls back to the mime type when filename is absent", () => {
    const part = makeFilePart({
      mime: "application/pdf",
      filename: undefined,
      url: "data:application/pdf;base64,DDDD",
    });
    render(<AttachedFiles parts={[part]} />);

    expect(screen.getByText("application/pdf")).toBeTruthy();
  });

  it("offers 'Edit in Images' for a data:image part when onEditInImages is provided, and calls it with that part", () => {
    const onEditInImages = mock(() => {});
    const part = makeFilePart({
      mime: "image/png",
      filename: "screenshot.png",
      url: "data:image/png;base64,AAAA",
    });
    render(<AttachedFiles parts={[part]} onEditInImages={onEditInImages} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit in Images: screenshot.png" }));
    expect(onEditInImages).toHaveBeenCalledWith(part);
  });

  it("does not render 'Edit in Images' when onEditInImages is omitted", () => {
    const part = makeFilePart({
      mime: "image/png",
      filename: "screenshot.png",
      url: "data:image/png;base64,AAAA",
    });
    render(<AttachedFiles parts={[part]} />);
    expect(screen.queryByRole("button", { name: /Edit in Images/ })).toBeNull();
  });

  it("does not render 'Edit in Images' for a hosted (non-data-URL) image, even with the callback provided", () => {
    const onEditInImages = mock(() => {});
    const part = makeFilePart({
      mime: "image/png",
      filename: "shot.png",
      url: "https://example.com/shot.png",
    });
    render(<AttachedFiles parts={[part]} onEditInImages={onEditInImages} />);
    expect(screen.queryByRole("button", { name: /Edit in Images/ })).toBeNull();
  });

  it("renders multiple parts independently", () => {
    render(
      <AttachedFiles
        parts={[
          makeFilePart({ id: "p1", mime: "image/png", filename: "a.png" }),
          makeFilePart({
            id: "p2",
            mime: "application/pdf",
            filename: "b.pdf",
          }),
        ]}
      />,
    );

    expect(screen.getByTestId("attached-file-image")).toBeTruthy();
    expect(screen.getByTestId("attached-file-pdf")).toBeTruthy();
  });
});
