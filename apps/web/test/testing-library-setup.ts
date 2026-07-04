// Adds the `toBeInTheDocument()` / `toHaveTextContent()` etc. matchers used
// by the component tests. Must load after `happy-dom-setup.ts` (see the
// comment there on import-hoisting order).
import "@testing-library/jest-dom";

// RTL's auto-cleanup relies on detecting a Jest/Vitest-style global
// `afterEach`, which bun:test doesn't expose as an ambient global (it's
// only available via `import { afterEach } from "bun:test"`). Without this,
// every `render()` in a file accumulates in the DOM across tests, so
// `getByLabelText`/`getByText` start matching multiple stale nodes. Wire it
// up explicitly here instead.
import { afterEach } from "bun:test";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
