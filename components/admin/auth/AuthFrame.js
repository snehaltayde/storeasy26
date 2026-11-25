import { StoreasyMark } from "@/components/kit/storeasy-mark";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/components/ui/utils";

// The frame of the merchant sign-in, reset and accept-invite pages (Phase 2
// line 11, docs/UI.md "Sign-in, reset and accepting an invite"): the lockup
// (the Storeasy mark, the page's one h1 and one intro line) above one card,
// at most 384px wide, in the layout's centred column. The same shape as the
// operator sign-in. `headingRef` lets a state move focus to the h1; the rest
// of the props (data-auth, data-invite, role) land on the section.
export function AuthFrame({ title, intro, headingRef, children, className, ...rest }) {
  return (
    <section className={cn("space-y-6", className)} {...rest}>
      <div className="flex items-start gap-3">
        <StoreasyMark className="size-8" />
        <div className="min-w-0 space-y-0.5">
          <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="text-lg leading-8 font-semibold break-words outline-none">
            {title}
          </h1>
          {intro && <div className="text-muted-foreground">{intro}</div>}
        </div>
      </div>
      {children && (
        <Card>
          <CardContent className="px-6 py-2">{children}</CardContent>
        </Card>
      )}
    </section>
  );
}

// The intro line that names the store: one line, truncated, the full name on hover.
export function StoreName({ name }) {
  return (
    <p className="truncate" title={name || undefined}>
      Store console for <span className="font-medium text-foreground">{name || "your store"}</span>
    </p>
  );
}
