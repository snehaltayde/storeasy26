import Image from "@/components/StoreImage";
import { tfetch } from "@/lib/storefront-request";
import StripToken from "@/components/reviews/StripToken";
import { LIMITS, REFUSED, openInvite, reviewsActive } from "@/lib/reviews/store";
import { FIELD_WORDS, WRITE_WORDS } from "@/lib/reviews/words";

// Phase 9 line 1: a buyer writes a review from the signed link in their order
// page or invite email (?t=). A plain HTML form: it works with no JavaScript
// (the browser checks the lengths; POST /api/reviews checks them again and
// answers with a redirect back here). A used, expired, tampered or other-store
// link gets one sentence that reveals nothing about the order. The token never
// leaves the page: referrer policy origin (no-referrer would make the form post
// Origin: null, which the origin check refuses), no third-party pixels on
// /reviews/* (lib/track/no-pixels.js), and StripToken takes ?t= out of the address.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Write a review", robots: { index: false }, referrer: "origin" };

function Shell({ children }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <StripToken />
      {children}
    </div>
  );
}

export default async function WriteReviewPage({ searchParams }) {
  const sp = (await searchParams) ?? {};
  if (sp.done) {
    return (
      <Shell>
        <h1 className="text-2xl font-extrabold tracking-tight">Review sent</h1>
        <p className="mt-3 text-sf-text-muted" data-review-done="">
          {WRITE_WORDS.thanks}
        </p>
      </Shell>
    );
  }
  const token = typeof sp.t === "string" ? sp.t : "";
  const opened = token ? await tfetch(async () => ((await reviewsActive()) ? openInvite(token) : null)) : null;
  if (!opened) {
    return (
      <Shell>
        <h1 className="text-2xl font-extrabold tracking-tight">Write a review</h1>
        <p className="mt-3 text-sf-text-muted" data-review-refused="">
          {REFUSED}
        </p>
      </Shell>
    );
  }
  const { product, suggestedName } = opened;
  const errs = new Set(String(sp.err || "").split(",").filter(Boolean));
  const field = "mt-1 w-full rounded-sf-control border border-sf-border bg-sf-surface px-3 py-2 text-sm text-sf-text";
  const note = (k) => (errs.has(k) ? <p className="mt-1 text-xs font-semibold text-sf-danger">{FIELD_WORDS[k]}</p> : null);
  return (
    <Shell>
      <h1 className="text-2xl font-extrabold tracking-tight">Write a review</h1>
      <div className="mt-5 flex items-center gap-4">
        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-sf-small bg-sf-surface-muted">
          {product.featured_image ? <Image src={product.featured_image} alt={product.featured_image_alt || product.title} fill sizes="64px" className="object-cover" /> : null}
        </div>
        <p className="font-semibold text-sf-text" data-review-product="">
          {product.title}
        </p>
      </div>
      {errs.size ? (
        <p className="mt-5 rounded-sf-card border border-sf-border bg-sf-surface-muted p-3 text-sm" role="alert">
          {errs.has("server") ? WRITE_WORDS.server : WRITE_WORDS.fix}
        </p>
      ) : null}
      <form method="post" action="/api/reviews" className="mt-6 space-y-5" data-review-form="">
        <input type="hidden" name="t" value={token} />
        <fieldset>
          <legend className="text-sm font-semibold text-sf-text">Your rating</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {[5, 4, 3, 2, 1].map((n) => (
              <label key={n} className="inline-flex cursor-pointer items-center gap-1.5 rounded-sf-control border border-sf-border px-3 py-2 text-sm has-[:checked]:border-sf-accent has-[:checked]:font-semibold">
                <input type="radio" name="rating" value={n} required className="accent-current" />
                <span aria-hidden="true" className="text-sf-accent-text">
                  {"★".repeat(n)}
                </span>
                <span>
                  {n} {n === 1 ? "star" : "stars"}
                </span>
              </label>
            ))}
          </div>
          {note("rating")}
        </fieldset>
        <label className="block text-sm font-semibold text-sf-text">
          Title <span className="font-normal text-sf-text-muted">(optional)</span>
          <input name="title" maxLength={LIMITS.title} className={field} />
          {note("title")}
        </label>
        <label className="block text-sm font-semibold text-sf-text">
          Your review
          <textarea name="body" required minLength={LIMITS.bodyMin} maxLength={LIMITS.bodyMax} rows={6} className={field} />
          <span className="mt-1 block text-xs font-normal text-sf-text-muted">
            {LIMITS.bodyMin} to {LIMITS.bodyMax} characters.
          </span>
          {note("body")}
        </label>
        <label className="block text-sm font-semibold text-sf-text">
          Name to show
          <input name="display_name" required maxLength={LIMITS.name} defaultValue={suggestedName} className={field} />
          <span className="mt-1 block text-xs font-normal text-sf-text-muted">{WRITE_WORDS.privacy}</span>
          {note("display_name")}
        </label>
        <button type="submit" className="rounded-sf-control bg-sf-accent px-6 py-3 text-sm font-bold text-sf-on-accent hover:bg-sf-accent-hover">
          Send review
        </button>
      </form>
    </Shell>
  );
}
