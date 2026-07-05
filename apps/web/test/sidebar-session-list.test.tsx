import { describe, it, expect, mock } from "bun:test";
import { render, screen, within, fireEvent } from "@testing-library/react";
import {
  SidebarSessionList,
  SESSION_LIST_LIMIT,
} from "../src/components/sidebar-session-list";
import { SidebarProvider } from "../src/components/ui/sidebar";
import type { Session } from "@opencode-ai/sdk/v2";

// Claude Code /rc parity: the sidebar pins the most-recently-updated
// session as "Live" and only lists the most recent ones -- verified here
// purely at the component level (fixtures fed directly, out of order) so
// the sort/pin/cap behavior is locked in independent of how `useSessions()`
// happens to order its own cache.

function session(
  overrides: Partial<Omit<Session, "time">> & {
    id: string;
    // `updated` is intentionally optional here (unlike the real SDK type)
    // so fixtures can exercise the `time.updated ?? time.created` fallback
    // below without fighting the type checker.
    time?: Partial<Session["time"]> & { created: number };
  },
): Session {
  return {
    slug: overrides.id,
    projectID: "proj_1",
    directory: "/tmp/project",
    version: "1",
    title: `session ${overrides.id}`,
    time: { created: 1, updated: 1 },
    ...overrides,
  } as Session;
}

function renderList(sessions: Session[], onDeleteSession = mock(() => {})) {
  return render(
    <SidebarProvider>
      <SidebarSessionList sessions={sessions} onDeleteSession={onDeleteSession} />
    </SidebarProvider>,
  );
}

// `SidebarItem` itself is also a react-aria `Link` with `role="link"` (it
// has no `href`), wrapping the real per-session anchor rendered by
// `SidebarLink` -- so `getAllByRole("link")` returns both per session.
// Only the actual `<a href="/session/...">` is the one under test.
function sessionAnchors(): HTMLAnchorElement[] {
  return screen
    .getAllByRole("link")
    .filter((el): el is HTMLAnchorElement => el.tagName === "A");
}

describe("SidebarSessionList", () => {
  it("pins the most-recently-updated session first with a LIVE badge, out-of-order input", () => {
    const sessions = [
      session({ id: "old", title: "old work", time: { created: 1, updated: 1 } }),
      session({ id: "newest", title: "newest work", time: { created: 3, updated: 5 } }),
      session({ id: "middle", title: "middle work", time: { created: 2, updated: 2 } }),
    ];

    renderList(sessions);

    const links = sessionAnchors();
    expect(links.map((link) => link.textContent)).toEqual([
      expect.stringContaining("newest work"),
      expect.stringContaining("middle work"),
      expect.stringContaining("old work"),
    ]);

    // Only the newest session's link carries the LIVE badge.
    expect(within(links[0]).getByText("LIVE")).toBeInTheDocument();
    expect(within(links[1]).queryByText("LIVE")).not.toBeInTheDocument();
    expect(within(links[2]).queryByText("LIVE")).not.toBeInTheDocument();
  });

  it("falls back to time.created when time.updated is absent", () => {
    const sessions = [
      session({ id: "a", title: "a work", time: { created: 10 } }),
      session({ id: "b", title: "b work", time: { created: 20 } }),
    ];

    renderList(sessions);

    const links = sessionAnchors();
    expect(links[0].textContent).toContain("b work");
    expect(within(links[0]).getByText("LIVE")).toBeInTheDocument();
  });

  it(`caps the rendered list at ${SESSION_LIST_LIMIT} sessions`, () => {
    const sessions = Array.from({ length: SESSION_LIST_LIMIT + 5 }, (_, index) =>
      session({
        id: `s${index}`,
        title: `session ${index}`,
        time: { created: index, updated: index },
      }),
    );

    renderList(sessions);

    const links = sessionAnchors();
    expect(links).toHaveLength(SESSION_LIST_LIMIT);
    // The newest `SESSION_LIST_LIMIT` sessions survive the cap -- the
    // oldest ones (lowest `time.updated`) are dropped.
    expect(screen.queryByText(/session 0$/)).not.toBeInTheDocument();
    expect(screen.getByText(`session ${SESSION_LIST_LIMIT + 4}`)).toBeInTheDocument();
  });

  it("calls onDeleteSession with the session id when Delete Session is chosen", async () => {
    const onDeleteSession = mock(() => {});
    const sessions = [session({ id: "only", title: "only work" })];

    renderList(sessions, onDeleteSession);

    const trigger = screen.getByRole("button", { name: "Session options" });
    fireEvent.click(trigger);

    const deleteItem = await screen.findByText("Delete Session");
    fireEvent.click(deleteItem);

    expect(onDeleteSession).toHaveBeenCalledWith("only");
  });
});
