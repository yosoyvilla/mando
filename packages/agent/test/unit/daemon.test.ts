import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrame, serializeFrame, type Frame } from "@mando/protocol";
import { runDaemon, type DaemonEvent, type DaemonSocket } from "../../src/daemon";

// A minimal stand-in for daemon.ts's DaemonSocket interface -- no real
// network, no real WebSocket. `emit` calls listeners synchronously (like a
// real EventTarget would for a same-tick dispatch), which is what lets
// these tests drive the daemon's message loop deterministically without
// waiting on anything.
class FakeSocket implements DaemonSocket {
  readyState = 0; // WebSocket.CONNECTING
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Array<(evt: any) => void>> = { open: [], message: [], close: [], error: [] };

  addEventListener(type: "open" | "message" | "close" | "error", listener: (evt: any) => void): void {
    this.listeners[type].push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3; // WebSocket.CLOSED
    this.emit("close", {});
  }

  // Simulates the underlying connection dying on the wire (hub restart,
  // network blip) -- as opposed to `close()`, which is what the daemon
  // itself calls during its own stop().
  simulateDrop(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  triggerOpen(): void {
    this.readyState = 1; // WebSocket.OPEN
    this.emit("open", {});
  }

  triggerMessage(frame: Frame): void {
    this.emit("message", { data: serializeFrame(frame) });
  }

  private emit(type: string, evt: unknown): void {
    for (const listener of this.listeners[type]!) listener(evt);
  }
}

function sentFrames(socket: FakeSocket): Frame[] {
  return socket.sent.map((raw) => parseFrame(raw));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function decodeChunks(frames: Frame[]): string {
  return frames
    .filter((f) => f.type === "response_chunk")
    .map((f) => Buffer.from((f as { payload: { data: string } }).payload.data, "base64").toString())
    .join("");
}

let stubOpencode: ReturnType<typeof Bun.serve> | null = null;
let tmpDir: string | null = null;

afterEach(() => {
  stubOpencode?.stop(true);
  stubOpencode = null;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function newPidFile(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "mando-daemon-test-"));
  return join(tmpDir, "pid");
}

describe("runDaemon", () => {
  it("sends hello on open, dispatches ping->pong once registered, and writes a pidfile", async () => {
    const sockets: FakeSocket[] = [];
    const events: DaemonEvent[] = [];
    const controller = new AbortController();
    const pidFile = newPidFile();

    const daemonPromise = runDaemon({
      hubUrl: "http://hub.invalid",
      token: "tok-1",
      machineName: "machine-1",
      opencodePort: 4096,
      pidFile,
      wsFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      checkHealth: async () => true,
      healthCheckIntervalMs: 1_000_000, // effectively disabled for this test
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    });

    expect(sockets).toHaveLength(1);
    expect(existsSync(pidFile)).toBe(true);
    expect(Number(readFileSync(pidFile, "utf-8"))).toBe(process.pid);

    sockets[0]!.triggerOpen();
    const hello = sentFrames(sockets[0]!)[0];
    expect(hello).toMatchObject({
      type: "hello",
      payload: { token: "tok-1", machineName: "machine-1", opencodePort: 4096 },
    });

    sockets[0]!.triggerMessage({ type: "registered", id: hello!.id, payload: { machineId: "m-1" } });
    expect(events.some((e) => e.type === "registered" && e.machineId === "m-1")).toBe(true);

    sockets[0]!.triggerMessage({ type: "ping", id: "ping-1" });
    const pong = sentFrames(sockets[0]!).find((f) => f.type === "pong");
    expect(pong).toMatchObject({ type: "pong", id: "ping-1" });

    controller.abort();
    await daemonPromise;
    expect(existsSync(pidFile)).toBe(false);
  });

  it("forwards http_request frames to the local opencode stub and streams the response back", async () => {
    stubOpencode = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/ping") return new Response("pong", { status: 200 });
        return new Response("not found", { status: 404 });
      },
    });
    const opencodePort = stubOpencode.port!;

    const sockets: FakeSocket[] = [];
    const controller = new AbortController();

    const daemonPromise = runDaemon({
      hubUrl: "http://hub.invalid",
      token: "tok-2",
      machineName: "machine-2",
      opencodePort,
      pidFile: newPidFile(),
      wsFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      checkHealth: async () => true,
      healthCheckIntervalMs: 1_000_000,
      signal: controller.signal,
    });

    sockets[0]!.triggerOpen();
    sockets[0]!.triggerMessage({ type: "registered", id: "hello-2", payload: { machineId: "m-2" } });
    sockets[0]!.triggerMessage({
      type: "http_request",
      id: "req-1",
      payload: { method: "GET", path: "/ping", headers: {}, body: null },
    });

    await waitFor(() => sentFrames(sockets[0]!).some((f) => f.type === "response_end" && f.id === "req-1"));

    const frames = sentFrames(sockets[0]!).filter((f) => f.id === "req-1");
    expect(frames[0]).toMatchObject({ type: "response_begin", payload: { status: 200 } });
    expect(decodeChunks(frames)).toBe("pong");
    expect(frames[frames.length - 1]).toMatchObject({ type: "response_end" });

    controller.abort();
    await daemonPromise;
  });

  it("aborts the matching in-flight forward when a cancel frame arrives for its id", async () => {
    let sawAbort = false;
    stubOpencode = Bun.serve({
      port: 0,
      fetch(req) {
        return new Promise<Response>((resolve) => {
          req.signal.addEventListener("abort", () => {
            sawAbort = true;
          });
          setTimeout(() => resolve(new Response("too-late")), 5000);
        });
      },
    });
    const opencodePort = stubOpencode.port!;

    const sockets: FakeSocket[] = [];
    const controller = new AbortController();

    const daemonPromise = runDaemon({
      hubUrl: "http://hub.invalid",
      token: "tok-3",
      machineName: "machine-3",
      opencodePort,
      pidFile: newPidFile(),
      wsFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      checkHealth: async () => true,
      healthCheckIntervalMs: 1_000_000,
      signal: controller.signal,
    });

    sockets[0]!.triggerOpen();
    sockets[0]!.triggerMessage({ type: "registered", id: "hello-3", payload: { machineId: "m-3" } });
    sockets[0]!.triggerMessage({
      type: "http_request",
      id: "req-cancel",
      payload: { method: "GET", path: "/slow", headers: {}, body: null },
    });

    // Give the fetch time to actually reach the stub before cancelling.
    await new Promise((r) => setTimeout(r, 30));
    sockets[0]!.triggerMessage({ type: "cancel", id: "req-cancel", payload: {} });

    await waitFor(() => sawAbort);
    await waitFor(() =>
      sentFrames(sockets[0]!).some((f) => f.type === "response_error" && f.id === "req-cancel"),
    );
    const errorFrame = sentFrames(sockets[0]!).find((f) => f.type === "response_error" && f.id === "req-cancel");
    expect(errorFrame).toMatchObject({ payload: { code: "cancelled" } });

    controller.abort();
    await daemonPromise;
  });

  it("reconnects with nextDelay backoff after the socket drops, and resets attempt on registration", async () => {
    const sockets: FakeSocket[] = [];
    const nextDelayCalls: number[] = [];
    const controller = new AbortController();

    const daemonPromise = runDaemon({
      hubUrl: "http://hub.invalid",
      token: "tok-4",
      machineName: "machine-4",
      opencodePort: 4096,
      pidFile: newPidFile(),
      wsFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      checkHealth: async () => true,
      healthCheckIntervalMs: 1_000_000,
      nextDelay: (attempt) => {
        nextDelayCalls.push(attempt);
        return 5;
      },
      signal: controller.signal,
    });

    expect(sockets).toHaveLength(1);
    sockets[0]!.simulateDrop();

    await waitFor(() => sockets.length === 2);
    expect(nextDelayCalls).toEqual([0]);

    // Register on the second connection and confirm a second drop starts
    // backoff again from attempt 0 (proving registration resets it).
    sockets[1]!.triggerOpen();
    sockets[1]!.triggerMessage({ type: "registered", id: "hello-4b", payload: { machineId: "m-4" } });
    sockets[1]!.simulateDrop();

    await waitFor(() => sockets.length === 3);
    expect(nextDelayCalls).toEqual([0, 0]);

    controller.abort();
    await daemonPromise;
  });

  it("does not reconnect after an unrecoverable hub error frame (e.g. unauthorized token)", async () => {
    const sockets: FakeSocket[] = [];
    const events: DaemonEvent[] = [];
    const controller = new AbortController();
    const pidFile = newPidFile();

    const daemonPromise = runDaemon({
      hubUrl: "http://hub.invalid",
      token: "bad-token",
      machineName: "machine-5",
      opencodePort: 4096,
      pidFile,
      wsFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      checkHealth: async () => true,
      healthCheckIntervalMs: 1_000_000,
      onEvent: (e) => events.push(e),
    });

    sockets[0]!.triggerOpen();
    sockets[0]!.triggerMessage({ type: "error", id: "hello-5", payload: { code: "unauthorized", message: "nope" } });

    await daemonPromise; // should resolve on its own -- no signal needed.

    expect(sockets).toHaveLength(1); // never reconnected.
    expect(events.some((e) => e.type === "stopped" && e.reason === "hub_error:unauthorized")).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("stops after maxConsecutiveHealthFailures consecutive failed local-opencode health checks", async () => {
    const sockets: FakeSocket[] = [];
    const events: DaemonEvent[] = [];
    const pidFile = newPidFile();

    const daemonPromise = runDaemon({
      hubUrl: "http://hub.invalid",
      token: "tok-6",
      machineName: "machine-6",
      opencodePort: 4096,
      pidFile,
      wsFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      checkHealth: async () => false,
      healthCheckIntervalMs: 10,
      maxConsecutiveHealthFailures: 3,
      onEvent: (e) => events.push(e),
    });

    await daemonPromise;

    expect(events.filter((e) => e.type === "health_check").length).toBeGreaterThanOrEqual(3);
    expect(events.some((e) => e.type === "stopped" && e.reason === "opencode_unreachable")).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
  });
});
