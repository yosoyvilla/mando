import {
  ArrowRightStartOnRectangleIcon,
  ChevronUpDownIcon,
  Cog6ToothIcon,
  EllipsisHorizontalIcon,
  FileDiffIcon,
  HomeIcon,
  PlusIcon,
  ServerIcon,
  ShieldCheckIcon,
  TrashIcon,
} from "@/components/icons/lucide";
import { useEffect, useState, useMemo } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { Avatar } from "@/components/ui/avatar";
import { StatusDot } from "@/components/status-dot";
import {
  ComboBox,
  ComboBoxContent,
  ComboBoxDescription,
  ComboBoxInput,
  ComboBoxItem,
  ComboBoxLabel,
} from "@/components/ui/combo-box";
import { Link as UILink } from "@/components/ui/link";
import { toast } from "@/components/ui/toast";
import {
  Menu,
  MenuContent,
  MenuHeader,
  MenuItem,
  MenuSection,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarItem,
  SidebarLabel,
  SidebarLink,
  SidebarMenuTrigger,
  SidebarRail,
  SidebarSection,
  SidebarSectionGroup,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  useSessions,
  useCreateSession,
  useDeleteSession,
  useGitDiff,
  useMachines,
  useSelectedMachine,
} from "@/hooks/use-opencode";
import { useMachineStore } from "@/stores/machine-store";
import { useAuth } from "@/contexts/auth-context";
import { useNavigate, useMatch, useLocation } from "@tanstack/react-router";
import type { Session } from "@opencode-ai/sdk/v2";
import type { Machine } from "@/lib/hub-client";

function MachineSwitcher() {
  const navigate = useNavigate();
  const selectedMachineId = useMachineStore((s) => s.selectedMachineId);
  const setSelectedMachineId = useMachineStore((s) => s.setSelectedMachineId);
  const selectedMachine = useSelectedMachine();
  const { data } = useMachines();
  const machines: Machine[] = data ?? [];
  const [inputValue, setInputValue] = useState(selectedMachine?.name ?? "");

  useEffect(() => {
    setInputValue(selectedMachine?.name ?? "");
  }, [selectedMachine?.id, selectedMachine?.name]);

  const filteredMachines = useMemo(() => {
    const query = inputValue.trim().toLowerCase();

    if (!query || query === selectedMachine?.name.toLowerCase()) {
      return machines;
    }

    return machines.filter((item) =>
      `${item.name} ${item.platform ?? ""}`.toLowerCase().includes(query),
    );
  }, [inputValue, selectedMachine?.name, machines]);

  const handleSelectionChange = (key: React.Key | null) => {
    if (key == null) return;

    const selected = machines.find((item) => item.id === String(key));
    if (!selected || !selected.online) return;

    setSelectedMachineId(selected.id);
    setInputValue(selected.name);
    navigate({ to: "/" });
  };

  return (
    <div className="col-span-full min-w-0 py-1 in-data-[state=collapsed]:hidden">
      <ComboBox
        aria-label="Switch machine"
        selectedKey={selectedMachine?.id ?? null}
        inputValue={inputValue}
        onInputChange={setInputValue}
        onSelectionChange={handleSelectionChange}
        isDisabled={!data || machines.length === 0}
      >
        <ComboBoxInput
          prefix={
            <ServerIcon
              data-slot="icon"
              className="size-4 text-muted-fg"
              aria-hidden="true"
            />
          }
          placeholder={data ? "Select machine" : "Loading machines..."}
          className="h-8 rounded-md px-2.5 py-0"
        />
        <ComboBoxContent
          items={filteredMachines}
          popover={{
            placement: "bottom start",
            className: "w-(--trigger-width)",
          }}
        >
          {(item) => (
            <ComboBoxItem
              id={item.id}
              textValue={item.name}
              isDisabled={!item.online}
            >
              <StatusDot online={item.online} className="shrink-0" />
              <ComboBoxLabel className="min-w-0 truncate font-mono">
                {item.name}
              </ComboBoxLabel>
              <ComboBoxDescription className="flex min-w-0 items-center gap-2 text-xs">
                {item.platform && (
                  <span className="truncate font-mono">{item.platform}</span>
                )}
                <span className="shrink-0 font-mono">
                  {item.online ? "Online" : "Offline"}
                </span>
              </ComboBoxDescription>
            </ComboBoxItem>
          )}
        </ComboBoxContent>
      </ComboBox>
    </div>
  );
}

function truncateTitle(title: string, maxLength = 40): string {
  if (title.length <= maxLength) return title;
  const halfLength = Math.floor((maxLength - 3) / 2);
  return `${title.slice(0, halfLength)}...${title.slice(-halfLength)}`;
}

export default function AppSidebar(
  props: React.ComponentProps<typeof Sidebar>,
) {
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { setIsOpenOnMobile } = useSidebar();
  const selectedMachine = useSelectedMachine();
  const { user, logout } = useAuth();
  const identityLabel = user?.email ?? "Account";
  const { data: sessionsData, mutate: mutateSessions } = useSessions();
  const createSession = useCreateSession();
  const deleteSession = useDeleteSession();
  const sessions: Session[] = sessionsData ?? [];

  // On phone, the sidebar renders as a Sheet drawer (see ui/sidebar.tsx's
  // isMobile branch) that only ever opens/closes via the hamburger trigger
  // -- nothing closes it after a navigation. Recon (Feature A) found that
  // creating or opening a session leaves the drawer open on top of the
  // chat, blocking the composer entirely. Closing on every route change
  // covers all navigation paths (session links, New Session, Diff) without
  // touching desktop, where `isOpenOnMobile` is inert.
  useEffect(() => {
    setIsOpenOnMobile(false);
  }, [location.pathname, setIsOpenOnMobile]);

  const { data: diffData } = useGitDiff();
  const diffFileCount = useMemo(() => {
    if (!diffData?.diff) return 0;
    try {
      const patches = parsePatchFiles(diffData.diff);
      return patches.reduce((count, patch) => count + patch.files.length, 0);
    } catch {
      return 0;
    }
  }, [diffData?.diff]);

  async function handleNewSession() {
    if (creating) return;
    setCreating(true);
    try {
      const session = await createSession();
      await mutateSessions();
      toast.success("Session created");
      navigate({ to: "/session/$id", params: { id: session.id } });
    } catch (error) {
      console.error("Failed to create session:", error);
      toast.error("Failed to create session");
    } finally {
      setCreating(false);
    }
  }

  const currentSessionMatch = useMatch({
    from: "/_app/session/$id",
    shouldThrow: false,
  });
  const currentSessionId = currentSessionMatch?.params?.id;

  async function handleDeleteSession(sessionId: string) {
    try {
      await deleteSession(sessionId);
      await mutateSessions();
      toast.success("Session deleted");
      // If we deleted the current session, navigate to home
      if (currentSessionId === sessionId) {
        navigate({ to: "/" });
      }
    } catch (error) {
      console.error("Failed to delete session:", error);
      toast.error("Failed to delete session");
    }
  }

  async function handleLogout() {
    try {
      await logout();
      navigate({ to: "/login" });
    } catch (error) {
      console.error("Failed to log out:", error);
      toast.error("Failed to log out");
    }
  }

  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <UILink href="/" className="flex items-center gap-x-2">
          <img src="/logo.svg" alt="OpenCode Mando" className="size-6" />
          <SidebarLabel className="font-mono font-medium tracking-tight">
            opencode <span className="text-muted-fg">mando</span>
          </SidebarLabel>
        </UILink>
      </SidebarHeader>
      <SidebarContent>
        <SidebarSectionGroup>
          <SidebarSection>
            <MachineSwitcher />
          </SidebarSection>

          <SidebarSection>
            <SidebarItem
              tooltip="New Session"
              onPress={handleNewSession}
              className="cursor-pointer gap-x-2"
              data-testid="new-session"
            >
              <PlusIcon className="size-4 shrink-0" data-slot="icon" />
              <SidebarLabel>
                {creating ? "Creating..." : "New Session"}
              </SidebarLabel>
            </SidebarItem>
            <SidebarItem
              tooltip="View Git Diff"
              href="/diff"
              className="cursor-pointer gap-x-2"
              badge={diffFileCount > 0 ? diffFileCount : undefined}
            >
              <FileDiffIcon className="size-4 shrink-0" data-slot="icon" />
              <SidebarLabel>Diff</SidebarLabel>
            </SidebarItem>
          </SidebarSection>

          <SidebarSection label="Sessions">
            {sessions.map((session) => (
              <SidebarItem key={session.id} tooltip={session.title}>
                {({ isCollapsed, isFocused }) => (
                  <>
                    <SidebarLink href={`/session/${session.id}`}>
                      <SidebarLabel>
                        {truncateTitle(session.title)}
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
                            onAction={() => handleDeleteSession(session.id)}
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
          </SidebarSection>
        </SidebarSectionGroup>
      </SidebarContent>

      <SidebarFooter className="flex flex-row justify-between gap-4 group-data-[state=collapsed]:flex-col">
        <Menu>
          <MenuTrigger
            className="flex w-full items-center justify-between"
            aria-label="Profile"
          >
            <div className="flex items-center gap-x-2">
              <Avatar
                className="size-8 *:size-8 group-data-[state=collapsed]:size-6 group-data-[state=collapsed]:*:size-6"
                isSquare
                initials={identityLabel.slice(0, 2).toUpperCase()}
              />
              <div className="in-data-[collapsible=dock]:hidden text-sm">
                <SidebarLabel>{identityLabel}</SidebarLabel>
              </div>
            </div>
            <ChevronUpDownIcon data-slot="chevron" />
          </MenuTrigger>
          <MenuContent
            className="in-data-[sidebar-collapsible=collapsed]:min-w-56 min-w-(--trigger-width)"
            placement="bottom right"
          >
            <MenuSection>
              <MenuHeader separator>
                <span className="block">{identityLabel}</span>
                {selectedMachine && (
                  <span className="block font-mono text-muted-fg text-xs">
                    {selectedMachine.name}
                  </span>
                )}
              </MenuHeader>
            </MenuSection>

            <MenuItem href="#dashboard">
              <HomeIcon />
              Dashboard
            </MenuItem>
            <MenuItem href="/settings">
              <Cog6ToothIcon />
              Settings
            </MenuItem>
            <MenuItem href="#security">
              <ShieldCheckIcon />
              Security
            </MenuItem>
            <MenuSeparator />
            <MenuItem onAction={handleLogout}>
              <ArrowRightStartOnRectangleIcon />
              Log out
            </MenuItem>
          </MenuContent>
        </Menu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
