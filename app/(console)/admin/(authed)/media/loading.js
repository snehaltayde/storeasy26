import { Skeleton } from "@/components/ui/skeleton";
import { MediaGridSkeleton } from "@/components/admin/media/MediaGrid";

// The media screen while its first page loads: the title row, the tabs and
// toolbar, and a grid of thumbnail-shaped skeletons (docs/UI.md "States").
export default function MediaLoading() {
  return (
    <div aria-busy="true" aria-label="Loading your files">
      <Skeleton className="mb-2 h-7 w-32" />
      <Skeleton className="mb-6 h-4 w-80 max-w-full" />
      <Skeleton className="mb-4 h-9 w-56" />
      <MediaGridSkeleton />
    </div>
  );
}
