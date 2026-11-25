import { StoreasyMark } from "@/components/kit/storeasy-mark";

// The console's 404 (S50; new UI since Phase 2 line 11): neutral, and also
// where a gated host lands when a console page's store lookup calls notFound().
// The sign-in frame's lockup (the mark, the h1 and a line), with no card: there
// is nothing to do here, and it names no store and no way in.
export default function ConsoleNotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12 text-sm text-foreground">
      <div className="flex w-full max-w-sm items-start gap-3">
        <StoreasyMark className="size-8" />
        <div className="min-w-0 space-y-0.5">
          <h1 className="text-lg leading-8 font-semibold">Page not found</h1>
          <p className="text-muted-foreground">This console page doesn&rsquo;t exist, or this store isn&rsquo;t available here.</p>
        </div>
      </div>
    </main>
  );
}
