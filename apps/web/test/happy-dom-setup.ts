import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registers a DOM (window, document, EventSource, etc.) on globalThis so
// React Testing Library can render components under `bun test`, which has
// no DOM by default.
//
// This MUST be its own preload file, loaded before any other setup file
// that imports `@testing-library/*`: ES module imports are hoisted, so a
// file that both imports `@testing-library/react` and calls
// `GlobalRegistrator.register()` would run testing-library's import (and
// its one-time `document`-presence check that builds the `screen` helper
// object) before `register()` ever executes, permanently wiring `screen.*`
// to throw "document has to be available".
GlobalRegistrator.register();
