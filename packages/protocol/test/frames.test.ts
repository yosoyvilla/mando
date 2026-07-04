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

test("hello carries token, machine name, port, version", () => {
  const f = {
    type: "hello",
    id: "h-1",
    payload: { token: "t", machineName: "laptop", opencodePort: 4096, agentVersion: "0.1.0" },
  } as const;
  expect(parseFrame(serializeFrame(f))).toEqual(f);
});
