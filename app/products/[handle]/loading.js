export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-5 h-4 w-52 animate-pulse rounded bg-zinc-100" />
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
        <div className="aspect-square w-full animate-pulse rounded-2xl bg-zinc-100" />
        <div>
          <div className="h-4 w-24 animate-pulse rounded bg-zinc-100" />
          <div className="mt-2 h-8 w-3/4 animate-pulse rounded bg-zinc-100" />
          <div className="mt-5 h-7 w-32 animate-pulse rounded bg-zinc-100" />
          <div className="mt-6 h-12 w-full animate-pulse rounded-xl bg-zinc-100" />
          <div className="mt-8 space-y-2">
            <div className="h-3 w-full animate-pulse rounded bg-zinc-100" />
            <div className="h-3 w-5/6 animate-pulse rounded bg-zinc-100" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-zinc-100" />
          </div>
        </div>
      </div>
    </div>
  );
}
