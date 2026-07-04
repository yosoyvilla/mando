import { createFileRoute } from "@tanstack/react-router";
import { RequireAuth } from "@/components/require-auth";
import { PairingView } from "@/components/pairing-view";

interface PairSearch {
  code?: string;
}

export const Route = createFileRoute("/pair")({
  validateSearch: (search: Record<string, unknown>): PairSearch => ({
    code: typeof search.code === "string" ? search.code : undefined,
  }),
  component: PairPage,
});

function PairPage() {
  const { code } = Route.useSearch();

  return (
    <RequireAuth>
      <PairingView initialCode={code ?? ""} />
    </RequireAuth>
  );
}
