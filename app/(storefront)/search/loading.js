import { ProductGridSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <div className="h-7 w-56 max-w-full animate-pulse rounded bg-zinc-100" />
      <div className="mt-8">
        <ProductGridSkeleton count={8} />
      </div>
    </div>
  );
}
