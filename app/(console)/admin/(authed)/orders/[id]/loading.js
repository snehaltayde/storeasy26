import { Skeleton } from "@/components/ui/skeleton";

// One order while it loads: the title row, the two cards, the lines and the
// timeline, shaped like the page (docs/UI.md "States").
const Block = ({ lines = 4 }) => (
  <div className="rounded-card border border-border bg-card p-4">
    <Skeleton className="mb-4 h-5 w-32" />
    {Array.from({ length: lines }, (_, i) => (
      <Skeleton key={i} className="mt-2 h-4 w-full" />
    ))}
  </div>
);

export default function OrderLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the order">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-2 h-7 w-72 max-w-full" />
      <Skeleton className="mt-2 mb-6 h-4 w-56" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Block />
        <Block />
      </div>
      <div className="mt-4">
        <Block lines={5} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Block lines={2} />
        <Block lines={2} />
      </div>
    </div>
  );
}
