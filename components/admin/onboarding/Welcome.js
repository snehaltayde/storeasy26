import { Fragment } from "react";
import { CircleCheck, Globe } from "lucide-react";

// The top of the onboarding page (Phase 1 line 1, trimmed to the store card in
// line 3): the headline and a short, flat block with what the founder now owns
// (the address, whether shoppers can see it, who is signed in). Flat like the
// signup screens (components/admin/signup/SignupFlow.js), so the step panel
// below is the only card and the one place the eye goes. Read only; the steps
// are Onboarding.js. Props: see app/(console)/admin/(authed)/onboarding/page.js.
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
    <div data-onboarding="welcome" className="space-y-4">
      <header className="space-y-3">
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-[-0.01em] [overflow-wrap:anywhere] text-foreground">Welcome to {storeName}</h1>
        <p className="text-sm text-muted-foreground">{open ? "Your store is open. Everything below is done; change anything from the editor." : "Four steps to open your store. Nobody else can see it until you open it."}</p>
      </header>

      <section aria-label="Your store" className="space-y-1 border-l-2 border-border pl-3 text-[0.8125rem]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Globe aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <p className="min-w-0 font-mono text-foreground [overflow-wrap:anywhere]" data-onboarding="address">
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
        <p className="text-muted-foreground">{open ? "Shoppers can visit your store." : "Shoppers see “Opening soon” until you publish your store for the first time."}</p>
        {account?.email && (
          <p className="flex items-start gap-1.5 text-muted-foreground" data-onboarding="email">
            {account.verified && <CircleCheck aria-hidden className="mt-[3px] size-3.5 shrink-0 text-success" />}
            <span className="min-w-0 break-words">
              Signed in as <span className="text-foreground">{account.email}</span>
              {account.verified ? ", email verified" : ""}
            </span>
          </p>
        )}
      </section>
    </div>
  );
}
