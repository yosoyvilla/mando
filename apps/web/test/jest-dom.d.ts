// `@testing-library/jest-dom`'s own bun typings (`types/bun.d.ts`) aren't
// reachable through its package.json `exports` map (only ".", "./matchers",
// "./jest-globals", "./vitest" are exported), so `tsc`'s bundler module
// resolution can't import them. This declares just the handful of matchers
// these tests actually use, merged into bun:test's `Matchers<T>` interface
// via the declaration-merging pattern bun-types documents.
declare module "bun:test" {
  interface Matchers<T> {
    toBeInTheDocument(): void;
    toHaveTextContent(text: string | RegExp): void;
    toHaveValue(value: string | string[] | number): void;
    toBeDisabled(): void;
  }
}

export {};
