// The console's 404 (S50; new UI since Phase 2 line 11): neutral, and also
// where a gated host lands when a console page's store lookup calls notFound().
export default function ConsoleNotFound() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center px-4 text-sm text-foreground">
      <div className="w-full rounded-card border border-border bg-card p-8 text-center shadow-card">
        <p className="font-semibold">404: not found</p>
        <p className="mt-1 text-muted-foreground">This console page doesn&rsquo;t exist, or this store isn&rsquo;t available here.</p>
      </div>
    </div>
  );
}
