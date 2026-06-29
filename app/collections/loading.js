export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <div className="h-8 w-48 animate-pulse rounded bg-zinc-100" />
      <div className="mt-2 h-4 w-32 animate-pulse rounded bg-zinc-100" />
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="aspect-[4/3] animate-pulse rounded-2xl bg-zinc-100" />
        ))}
      </div>
    </div>
  );
}
