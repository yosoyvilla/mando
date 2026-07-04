import { test, expect } from "bun:test";
import { Registry, type Conn } from "../../src/tunnel/registry";

function fakeConn(): Conn {
  return {
    send() {},
    onResponse() {},
    close() {},
  };
}

test("add then get returns the same conn", () => {
  const registry = new Registry();
  const conn = fakeConn();

  registry.add("machine-1", conn);

  expect(registry.get("machine-1")).toBe(conn);
});

test("get returns null for a machine that was never added", () => {
  const registry = new Registry();

  expect(registry.get("unknown-machine")).toBeNull();
});

test("get returns null after remove", () => {
  const registry = new Registry();
  const conn = fakeConn();
  registry.add("machine-1", conn);

  registry.remove("machine-1");

  expect(registry.get("machine-1")).toBeNull();
});

test("remove is safe to call for a machine that was never added", () => {
  const registry = new Registry();

  expect(() => registry.remove("never-added")).not.toThrow();
});

test("distinct machines are tracked independently", () => {
  const registry = new Registry();
  const connA = fakeConn();
  const connB = fakeConn();

  registry.add("machine-a", connA);
  registry.add("machine-b", connB);
  registry.remove("machine-a");

  expect(registry.get("machine-a")).toBeNull();
  expect(registry.get("machine-b")).toBe(connB);
});
