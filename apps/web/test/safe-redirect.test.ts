import { describe, it, expect } from "bun:test";
import { getSafePostLoginRedirect } from "../src/lib/safe-redirect";

describe("getSafePostLoginRedirect", () => {
  it("returns the redirect target when it is a safe app-internal path", () => {
    expect(getSafePostLoginRedirect("/pair?code=ABCD-1234")).toBe(
      "/pair?code=ABCD-1234",
    );
  });

  it("falls back to / when redirect is missing", () => {
    expect(getSafePostLoginRedirect(undefined)).toBe("/");
  });

  it("falls back to / when redirect is an absolute URL with a scheme", () => {
    expect(getSafePostLoginRedirect("https://evil.com")).toBe("/");
  });

  it("falls back to / when redirect is protocol-relative", () => {
    expect(getSafePostLoginRedirect("//evil.com")).toBe("/");
  });

  it("falls back to / when redirect uses a backslash to fake a protocol-relative URL", () => {
    expect(getSafePostLoginRedirect("/\\evil.com")).toBe("/");
  });

  it("falls back to / when redirect does not start with a slash", () => {
    expect(getSafePostLoginRedirect("pair?code=ABCD-1234")).toBe("/");
  });
});
