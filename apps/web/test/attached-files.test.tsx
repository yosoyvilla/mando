import { describe, it, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
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

  it("renders an image part inline with a link to the data URL", () => {
    const part = makeFilePart({
      mime: "image/png",
      filename: "screenshot.png",
      url: "data:image/png;base64,AAAA",
    });
    render(<AttachedFiles parts={[part]} />);

    const img = screen.getByAltText("screenshot.png") as HTMLImageElement;
    expect(img.src).toBe("data:image/png;base64,AAAA");

    const link = screen.getByTestId("attached-file-image") as HTMLAnchorElement;
    expect(link.href).toBe("data:image/png;base64,AAAA");
    expect(link.target).toBe("_blank");
  });

  it("renders a pdf part as a labeled chip, not an image", () => {
    const part = makeFilePart({
      mime: "application/pdf",
      filename: "report.pdf",
      url: "data:application/pdf;base64,BBBB",
    });
    render(<AttachedFiles parts={[part]} />);

    expect(screen.getByTestId("attached-file-pdf")).toBeTruthy();
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();

    const link = screen.getByTestId("attached-file-pdf") as HTMLAnchorElement;
    expect(link.href).toBe("data:application/pdf;base64,BBBB");
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
