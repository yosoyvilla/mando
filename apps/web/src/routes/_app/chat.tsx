import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { ChatView } from "@/components/chat-view";
import { useBreadcrumb } from "@/contexts/breadcrumb-context";

// User-scoped, independent of any paired machine (see docs/superpowers/
// plans/2026-07-05-chat-and-images-v2.md, Task 5b). `/_app.tsx`'s layout
// bypasses its "no machine selected -> redirect to /machines" gate for this
// exact pathname so the page renders even with zero machines paired.
export const Route = createFileRoute("/_app/chat")({
  component: ChatPage,
});

function ChatPage() {
  const { setPageTitle } = useBreadcrumb();

  useEffect(() => {
    setPageTitle("Chat");
    return () => setPageTitle(null);
  }, [setPageTitle]);

  return (
    <div className="container mx-auto flex h-full max-w-6xl flex-col space-y-2 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Chat</h1>
        <p className="text-sm text-muted-fg">
          Chat with your own provider, configured on the Settings page.
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <ChatView />
      </div>
    </div>
  );
}
