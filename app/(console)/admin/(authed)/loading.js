import { Skeleton, SkeletonText } from "@/components/console/bits";
import { ConsolePageFrame } from "@/components/admin/shell/AdminShell";

// Route-level loading state (S50): the sidebar persists; the content area
// shows a page-shaped skeleton instead of a blank screen. ED-01: on an editor
// route with no loading state of its own, the frame adds the menu button and
// the page padding the shell leaves out there.
export default function AdminLoading() {
  return (
    <ConsolePageFrame>
      <div aria-busy="true" aria-label="Loading">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-2 h-4 w-80" />
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-card border border-edge bg-surface p-5">
            <SkeletonText lines={4} />
          </div>
          <div className="rounded-card border border-edge bg-surface p-5">
            <SkeletonText lines={4} />
          </div>
        </div>
        <div className="mt-4 rounded-card border border-edge bg-surface p-5">
          <SkeletonText lines={6} />
        </div>
      </div>
    </ConsolePageFrame>
  );
}
