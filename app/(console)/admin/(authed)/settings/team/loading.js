import { Skeleton } from "@/components/ui/skeleton";
import { TeamSkeleton } from "@/components/admin/team/TeamPage";

// The team screen while it loads: the title row, then the members and
// invites cards as skeleton rows (docs/UI.md "States").
export default function TeamLoading() {
  return (
    <div aria-busy="true" aria-label="Loading your team">
      <Skeleton className="mb-2 h-4 w-28" />
      <Skeleton className="mb-2 h-7 w-24" />
      <Skeleton className="mb-6 h-4 w-80 max-w-full" />
      <TeamSkeleton />
    </div>
  );
}
