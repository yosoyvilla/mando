import { EllipsisHorizontalIcon, TrashIcon } from "@/components/icons/lucide";
import { Badge } from "@/components/ui/badge";
import {
  Menu,
  MenuContent,
  MenuItem,
} from "@/components/ui/menu";
import {
  SidebarItem,
  SidebarLabel,
  SidebarLink,
  SidebarMenuTrigger,
} from "@/components/ui/sidebar";
import { sortSessions } from "@/hooks/use-opencode";
import type { Session } from "@opencode-ai/sdk/v2";

// Claude Code /rc parity: the sidebar reads as "what I am working on right
// now", not an archive. Only the most recent sessions are worth scrolling
// through -- older ones are still reachable (search, direct link), just not
// listed here.
export const SESSION_LIST_LIMIT = 20;

function truncateTitle(title: string, maxLength = 40): string {
  if (title.length <= maxLength) return title;
  const halfLength = Math.floor((maxLength - 3) / 2);
  return `${title.slice(0, halfLength)}...${title.slice(-halfLength)}`;
}

interface SidebarSessionListProps {
  sessions: Session[];
  onDeleteSession: (sessionId: string) => void;
}

// Sorts newest-first and caps the list itself rather than trusting callers
// to have already done so -- `useSessions()` sorts its own cache too, but
// this is the single place that decides what actually renders (and what
// gets the Live pin), so it re-asserts both invariants defensively.
export function SidebarSessionList({
  sessions,
  onDeleteSession,
}: SidebarSessionListProps) {
  const visibleSessions = sortSessions(sessions).slice(0, SESSION_LIST_LIMIT);

  return (
    <>
      {visibleSessions.map((session, index) => (
        <SidebarItem key={session.id} tooltip={session.title}>
          {({ isCollapsed, isFocused }) => (
            <>
              <SidebarLink href={`/session/${session.id}`}>
                <SidebarLabel className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate">
                    {truncateTitle(session.title)}
                  </span>
                  {index === 0 && (
                    <Badge
                      intent="success"
                      isCircle={false}
                      className="shrink-0 font-mono"
                    >
                      LIVE
                    </Badge>
                  )}
                </SidebarLabel>
              </SidebarLink>
              {(!isCollapsed || isFocused) && (
                <Menu>
                  <SidebarMenuTrigger aria-label="Session options">
                    <EllipsisHorizontalIcon />
                  </SidebarMenuTrigger>
                  <MenuContent
                    popover={{
                      offset: 0,
                      placement: "right top",
                    }}
                  >
                    <MenuItem
                      intent="danger"
                      onAction={() => onDeleteSession(session.id)}
                    >
                      <TrashIcon />
                      Delete Session
                    </MenuItem>
                  </MenuContent>
                </Menu>
              )}
            </>
          )}
        </SidebarItem>
      ))}
    </>
  );
}
