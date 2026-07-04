import { describe, it, expect, afterEach } from "bun:test";
import { checkHealth, detectOpencodePort } from "../../src/opencode";

let server: ReturnType<typeof Bun.serve> | null = null;
const originalOverride = process.env.MANDO_OPENCODE_PORT;

// Bun's Server.port is typed `number | undefined` (unix-socket servers have
// no port). Every server in this suite binds a TCP port (0 = ephemeral), so
// this just asserts that expectation instead of scattering `!` everywhere.
function requirePort(s: ReturnType<typeof Bun.serve>): number {
  if (typeof s.port !== "number") throw new Error("test server has no port (expected a TCP listener)");
  return s.port;
}

afterEach(() => {
  server?.stop(true);
  server = null;
  if (originalOverride === undefined) {
    delete process.env.MANDO_OPENCODE_PORT;
  } else {
    process.env.MANDO_OPENCODE_PORT = originalOverride;
  }
});

describe("checkHealth", () => {
  it("returns true when the port answers GET /doc", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 200 }) });
    expect(await checkHealth(requirePort(server))).toBe(true);
  });

  it("returns false when nothing is listening on the port", async () => {
    const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = requirePort(s);
    s.stop(true);
    expect(await checkHealth(port)).toBe(false);
  });
});

describe("detectOpencodePort", () => {
  it("returns the MANDO_OPENCODE_PORT override when it answers /doc", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = requirePort(server);
    process.env.MANDO_OPENCODE_PORT = String(port);

    expect(await detectOpencodePort()).toBe(port);
  });

  it("falls back to the default candidate port 4096 when no override is set", async () => {
    delete process.env.MANDO_OPENCODE_PORT;

    let stub: ReturnType<typeof Bun.serve>;
    try {
      stub = Bun.serve({ port: 4096, fetch: () => new Response("ok") });
    } catch {
      // Port 4096 is already occupied in this environment (e.g. a real
      // opencode instance) -- skip rather than produce a false failure.
      return;
    }
    try {
      expect(await detectOpencodePort()).toBe(4096);
    } finally {
      stub.stop(true);
    }
  });

  it("returns null when neither the override nor any default candidate answers", async () => {
    process.env.MANDO_OPENCODE_PORT = "1"; // reserved port, guaranteed closed for a plain client connect

    const candidateBusy = (await checkHealth(4096)) || (await checkHealth(4097));
    if (candidateBusy) {
      // Something is genuinely listening on a default candidate port in
      // this environment; detectOpencodePort would legitimately return it,
      // so skip rather than assert a false failure.
      return;
    }

    expect(await detectOpencodePort()).toBeNull();
  });
});
