import { test, expect } from "bun:test";
import { parseFrame, serializeFrame } from "../src/index";

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
