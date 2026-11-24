import { Fragment } from "react";
import Link from "next/link";
import { CircleCheck, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";

// The onboarding landing (Phase 1 line 1), new UI from components/ui: one
// centred column (the shell's onboarding mode caps it at 640px). Read only.
// One card holds what the founder now owns (the address, whether shoppers can
// see it, who is signed in); below it, the one next step and the one action.
// Props: see app/(console)/admin/(authed)/onboarding/page.js.
// a long address wraps before a dot, never mid-word
function BreakAtDots({ text }) {
  return text.split(".").map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {i > 0 && "."}
      {part}
    </Fragment>
  ));
}

export default function Welcome({ storeName, address, open, account }) {
  return (
    <div data-onboarding="welcome" className="space-y-8 pt-4 md:pt-8">
      <header className="space-y-3">
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-[-0.01em] text-foreground">Welcome to {storeName}</h1>
        <p className="text-sm text-muted-foreground">Your store is ready for you to set up. Nobody else can see it until you publish it.</p>
      </header>

      <section aria-label="Your store" className="rounded-card border border-border bg-card text-card-foreground shadow-card">
        <div className="space-y-3 p-4 md:p-6">
          <div className="flex items-start gap-3">
            <Globe aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="min-w-0 flex-1 font-mono text-sm [overflow-wrap:anywhere] md:text-base" data-onboarding="address">
              {address ? <BreakAtDots text={address} /> : "Your store's address is being set up"}
            </p>
            {open ? (
              <span data-onboarding="status" className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium tracking-[0.04em] text-success uppercase">
                Open
              </span>
            ) : (
              <span data-onboarding="status" className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium tracking-[0.04em] text-warning-text uppercase">
                Closed
              </span>
            )}
          </div>
          <p className="pl-7 text-sm text-muted-foreground">{open ? "Shoppers can visit your store." : "Shoppers see “Opening soon” until you publish your store for the first time."}</p>
        </div>
        {account?.email && (
          <p className="flex items-start gap-3 border-t border-border px-4 py-3 text-sm text-muted-foreground md:px-6" data-onboarding="email">
            {account.verified ? <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" /> : <span aria-hidden className="size-4 shrink-0" />}
            <span className="min-w-0 break-words">
              Signed in as <span className="text-foreground">{account.email}</span>
              {account.verified ? ", email verified" : ""}
            </span>
          </p>
        )}
      </section>

      <section aria-labelledby="onboarding-next" data-onboarding="next" className="space-y-3">
        <h2 id="onboarding-next" className="text-[1.125rem] font-semibold">
          Next: connect your Shopify store
        </h2>
        <p className="text-sm text-muted-foreground">
          Your storefront is built from the products in your Shopify store. Connecting it from here isn&apos;t ready yet; this page will walk you through it as soon as it is. Until then, nothing changes in your Shopify store.
        </p>
      </section>

      <Button asChild size="lg" className="h-10 w-full px-4 sm:w-auto">
        <Link href="/admin/dashboard">Go to your dashboard</Link>
      </Button>
    </div>
  );
}
