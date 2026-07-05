import { describe, it, expect } from "bun:test";
import {
  normalizeFetchedMessages,
  sessionMessagesToLegacy,
  type FilePart,
  type TextPart,
} from "../src/hooks/use-session-messages";

// Regression coverage for the plan-critic fix: the "user" SessionMessage
// variant only carried `text: string`, so file parts were silently dropped
// crossing the wire {info, parts} shape -> internal SessionMessage
// (normalize-in) and back out to the rendered {info, parts} shape
// (reconstruct-out).
describe("use-session-messages file part round trip", () => {
  const wireMessage = {
    info: {
      id: "msg_1",
      sessionID: "s1",
      role: "user" as const,
      time: { created: 1000 },
      agent: "user",
      model: { providerID: "", modelID: "" },
    },
    parts: [
      {
        id: "msg_1-text",
        sessionID: "s1",
        messageID: "msg_1",
        type: "text" as const,
        text: "hello",
      },
      {
        id: "msg_1-file-0",
        sessionID: "s1",
        messageID: "msg_1",
        type: "file" as const,
        mime: "image/png",
        filename: "a.png",
        url: "data:image/png;base64,AA==",
      },
    ],
  };

  it("normalize-in: preserves file parts on the user SessionMessage variant", () => {
    const [message] = normalizeFetchedMessages([wireMessage]);
    expect(message?.type).toBe("user");
    if (message?.type !== "user") throw new Error("expected user message");

    expect(message.text).toBe("hello");
    expect(message.files).toEqual([
      { uri: "data:image/png;base64,AA==", mime: "image/png", name: "a.png" },
    ]);
  });

  it("reconstruct-out: rebuilds a file part from the user SessionMessage's files field", () => {
    const [sessionMessage] = normalizeFetchedMessages([wireMessage]);
    if (!sessionMessage) throw new Error("expected a normalized message");

    const [legacyMessage] = sessionMessagesToLegacy([sessionMessage], "s1");
    if (!legacyMessage) throw new Error("expected a legacy message");

    const textPart = legacyMessage.parts.find(
      (part): part is TextPart => part.type === "text",
    );
    const filePart = legacyMessage.parts.find(
      (part): part is FilePart => part.type === "file",
    );

    expect(textPart?.text).toBe("hello");
    expect(filePart).toMatchObject({
      mime: "image/png",
      filename: "a.png",
      url: "data:image/png;base64,AA==",
    });
  });

  it("handles a file-only message (no text)", () => {
    const fileOnlyWire = {
      ...wireMessage,
      parts: wireMessage.parts.filter((part) => part.type === "file"),
    };

    const [sessionMessage] = normalizeFetchedMessages([fileOnlyWire]);
    if (sessionMessage?.type !== "user") throw new Error("expected user message");
    expect(sessionMessage.text).toBe("");
    expect(sessionMessage.files).toHaveLength(1);

    const [legacyMessage] = sessionMessagesToLegacy([sessionMessage], "s1");
    const filePart = legacyMessage?.parts.find(
      (part): part is FilePart => part.type === "file",
    );
    expect(filePart?.filename).toBe("a.png");
  });

  it("omits `files` entirely for a message with no attachments", () => {
    const textOnlyWire = {
      ...wireMessage,
      parts: wireMessage.parts.filter((part) => part.type === "text"),
    };

    const [sessionMessage] = normalizeFetchedMessages([textOnlyWire]);
    if (sessionMessage?.type !== "user") throw new Error("expected user message");
    expect(sessionMessage.files).toBeUndefined();
  });
});
