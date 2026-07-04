import { createHubClient } from "@/lib/hub-client";

// Single shared HubClient for the running app. Defaults to same-origin
// (baseUrl: "") since the hub serves this SPA in production. Components
// that need to be unit-testable accept an optional `client` prop that
// defaults to this singleton, so tests can inject a stub instead.
export const hubClient = createHubClient();
