import { buildApp, websocket, MAX_REQUEST_BODY_BYTES, type AppDeps } from "../../src/app";

export type TestServer = {
  url: string;
  wsUrl: string;
  stop(): void;
};

// Shared by tunnel (task 2.7), proxy (2.8), and e2e (8.1) integration
// tests. Boots one real Bun.serve on an ephemeral port with buildApp's
// Hono app wired to the same websocket handler it exports, so a real
// `new WebSocket(wsUrl)` can connect against it end to end (Hono's
// app.request() alone can't drive a WS upgrade).
export async function startTestServer(deps: AppDeps): Promise<TestServer> {
  const app = buildApp(deps);
  const server = Bun.serve({
    port: 0,
    fetch: app.fetch,
    websocket,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  });

  return {
    url: `http://localhost:${server.port}`,
    wsUrl: `ws://localhost:${server.port}/ws/agent`,
    stop() {
      server.stop(true);
    },
  };
}
