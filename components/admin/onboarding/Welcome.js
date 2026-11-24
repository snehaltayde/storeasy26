import Link from "next/link";
import { ArrowRight, CircleCheck, Store } from "lucide-react";
import { Button } from "@/components/ui/button";

// The onboarding landing (Phase 1 line 1), new UI from components/ui: one
// centred column (the shell's onboarding mode caps it at 640px). Read only.
// Props: see app/(console)/admin/(authed)/onboarding/page.js.
export default function Welcome({ storeName, address, open, account }) {
  return (
    <div data-onboarding="welcome" className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-[1.75rem] leading-tight font-semibold text-foreground">Welcome to {storeName}</h1>
        <p className="text-sm text-muted-foreground">Your store is ready for you to set up. Nobody else can see it until you publish it.</p>
      </header>

      <section aria-label="Your store" className="space-y-3 rounded-card border border-border bg-card p-4 text-card-foreground shadow-card">
        <div className="flex flex-wrap items-center gap-3">
          <Store aria-hidden className="size-4 text-muted-foreground" />
          <p className="min-w-0 flex-1 truncate font-mono text-sm" data-onboarding="address" title={address || undefined}>
            {address || "Your store's address is being set up"}
          </p>
          {open ? (
            <span data-onboarding="status" className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium tracking-[0.04em] text-success uppercase">
              Open
            </span>
          ) : (
            <span data-onboarding="status" className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium tracking-[0.04em] text-warning-text uppercase">
              Closed
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{open ? "Shoppers can visit your store." : "Shoppers see “Opening soon” until you publish your store for the first time."}</p>
        {account?.email && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground" data-onboarding="email">
            {account.verified && <CircleCheck aria-hidden className="size-4 text-success" />}
            <span>
              Signed in as <span className="text-foreground">{account.email}</span>
              {account.verified ? " · email verified" : ""}
            </span>
          </p>
        )}
      </section>

      <section aria-labelledby="onboarding-next" data-onboarding="next" className="space-y-2 rounded-card border border-border bg-card p-4 text-card-foreground shadow-card">
        <h2 id="onboarding-next" className="text-[1.125rem] font-semibold">
          Next: connect your Shopify store
        </h2>
        <p className="text-sm text-muted-foreground">
          Your storefront is built from the products in your Shopify store. Connecting it from here isn&apos;t ready yet; this page will walk you through it as soon as it is. Until then, nothing changes in your Shopify store.
        </p>
      </section>

      <Button asChild variant="outline">
        <Link href="/admin/dashboard">
          Go to your dashboard
          <ArrowRight aria-hidden data-icon="inline-end" />
        </Link>
      </Button>
    </div>
  );
}
