import { describe, it, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionContinuityHint } from "../src/components/session-continuity-hint";

const STORAGE_KEY = "mando-hint-terminal-refresh";

describe("SessionContinuityHint", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it("renders the reopen-to-refresh note with an accessible dismiss button", () => {
    render(<SessionContinuityHint />);
    expect(screen.getByRole("note")).toBeTruthy();
    expect(screen.getByText(/reopen the session there/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss hint" })).toBeTruthy();
  });

  it("dismisses on click and persists the dismissal", () => {
    render(<SessionContinuityHint />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss hint" }));
    expect(screen.queryByRole("note")).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe("dismissed");
  });

  it("does not render at all once previously dismissed", () => {
    localStorage.setItem(STORAGE_KEY, "dismissed");
    render(<SessionContinuityHint />);
    expect(screen.queryByRole("note")).toBeNull();
  });
});
