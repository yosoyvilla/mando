import { test, expect } from "bun:test";
import { parseFrame, serializeFrame, PROTOCOL_VERSION } from "../src/index";

test("http_request roundtrips", () => {
  const f = {
    type: "http_request",
    id: "req-1",
    payload: { method: "GET", path: "/session", headers: {}, body: null },
  } as const;
  expect(parseFrame(serializeFrame(f))).toEqual(f);
});

test("response_chunk requires base64 data", () => {
  const raw = JSON.stringify({ type: "response_chunk", id: "req-1", payload: {} });
  expect(() => parseFrame(raw)).toThrow();
});

test("unknown type is rejected", () => {
  const raw = JSON.stringify({ type: "nope", id: "x", payload: {} });
  expect(() => parseFrame(raw)).toThrow();
});

test("response_begin rejects a status outside the 200-599 HTTP range", () => {
  const tooLow = JSON.stringify({ type: "response_begin", id: "req-1", payload: { status: 42, headers: {} } });
  const tooHigh = JSON.stringify({ type: "response_begin", id: "req-1", payload: { status: 999, headers: {} } });
  expect(() => parseFrame(tooLow)).toThrow();
  expect(() => parseFrame(tooHigh)).toThrow();
});

test("response_begin accepts the boundary statuses 200 and 599", () => {
  const low = { type: "response_begin", id: "req-1", payload: { status: 200, headers: {} } } as const;
  const high = { type: "response_begin", id: "req-1", payload: { status: 599, headers: {} } } as const;
  expect(parseFrame(serializeFrame(low))).toEqual(low);
  expect(parseFrame(serializeFrame(high))).toEqual(high);
});

test("hello carries token, machine name, port, version", () => {
  const f = {
    type: "hello",
    id: "h-1",
    payload: { token: "t", machineName: "laptop", opencodePort: 4096, agentVersion: "0.1.0" },
  } as const;
  expect(parseFrame(serializeFrame(f))).toEqual(f);
});

test("hello parses without protocolVersion (old agent build)", () => {
  const raw = JSON.stringify({
    type: "hello",
    id: "h-old",
    payload: { token: "t", machineName: "laptop", opencodePort: 4096, agentVersion: "0.0.9" },
  });
  const frame = parseFrame(raw);
  expect(frame.type).toBe("hello");
  if (frame.type === "hello") {
    expect(frame.payload.protocolVersion).toBeUndefined();
  }
});

test("hello parses with protocolVersion set", () => {
  const f = {
    type: "hello",
    id: "h-new",
    payload: {
      token: "t",
      machineName: "laptop",
      opencodePort: 4096,
      agentVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    },
  } as const;
  expect(parseFrame(serializeFrame(f))).toEqual(f);
});

test("PROTOCOL_VERSION is exported as an integer", () => {
  expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
});

test("hello parses without connectDirectory (agent build that predates it)", () => {
  const f = {
    type: "hello",
    id: "h-no-dir",
    payload: { token: "t", machineName: "laptop", opencodePort: 4096, agentVersion: "0.1.0" },
  } as const;
  const frame = parseFrame(serializeFrame(f));
  expect(frame.type).toBe("hello");
  if (frame.type === "hello") {
    expect(frame.payload.connectDirectory).toBeUndefined();
  }
});

test("hello carries connectDirectory when present", () => {
  const f = {
    type: "hello",
    id: "h-dir",
    payload: {
      token: "t",
      machineName: "laptop",
      opencodePort: 4096,
      agentVersion: "0.1.0",
      connectDirectory: "/Users/dev/my-project",
    },
  } as const;
  expect(parseFrame(serializeFrame(f))).toEqual(f);
});

test("hello strips unknown fields rather than rejecting the frame", () => {
  const raw = JSON.stringify({
    type: "hello",
    id: "h-unknown",
    payload: {
      token: "t",
      machineName: "laptop",
      opencodePort: 4096,
      agentVersion: "0.1.0",
      somethingFuture: "ignored",
    },
  });
  const frame = parseFrame(raw);
  expect(frame.type).toBe("hello");
  if (frame.type === "hello") {
    expect(frame.payload).not.toHaveProperty("somethingFuture");
  }
});
