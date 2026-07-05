import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { ImagesGallery } from "@/components/images-gallery";
import { useBreadcrumb } from "@/contexts/breadcrumb-context";

// User-scoped, independent of any paired machine (see docs/superpowers/
// plans/2026-07-05-image-generation.md, Task 4). `/_app.tsx`'s layout
// bypasses its "no machine selected -> redirect to /machines" gate for
// this exact pathname so the page renders even with zero machines paired.
export const Route = createFileRoute("/_app/images")({
  component: ImagesPage,
});

function ImagesPage() {
  const { setPageTitle } = useBreadcrumb();

  useEffect(() => {
    setPageTitle("Images");
    return () => setPageTitle(null);
  }, [setPageTitle]);

  return (
    <div className="container mx-auto max-w-5xl space-y-2 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Images</h1>
        <p className="text-sm text-muted-fg">
          Generate and edit images through your own provider, configured on
          the Settings page.
        </p>
      </div>
      <ImagesGallery />
    </div>
  );
}
