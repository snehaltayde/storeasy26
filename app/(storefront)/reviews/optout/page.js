import { tfetch } from "@/lib/storefront-request";
import { verifyOptOutToken } from "@/lib/reviews/tokens";
import { OPTOUT_WORDS } from "@/lib/reviews/words";

// Phase 9 line 1: "Don't ask me for reviews", from a review invite email. The
// link only opens this page; the opt-out is written by the button (a POST),
// so a mail scanner that follows links changes nothing. The link carries a
// signed hash of the email, never the email itself.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Review emails", robots: { index: false }, referrer: "same-origin" };

export default async function ReviewOptOutPage({ searchParams }) {
  const sp = (await searchParams) ?? {};
  const token = typeof sp.t === "string" ? sp.t : "";
  const valid = !sp.done && token ? await tfetch(() => verifyOptOutToken(token)) : null;
  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-extrabold tracking-tight">Review emails</h1>
      {sp.done ? (
        <p className="mt-3 text-sf-text-muted" data-optout-done="">
          {OPTOUT_WORDS.done}
        </p>
      ) : valid ? (
        <form method="post" action="/api/reviews" className="mt-4">
          <input type="hidden" name="kind" value="optout" />
          <input type="hidden" name="t" value={token} />
          <p className="text-sf-text-muted">{OPTOUT_WORDS.ask}</p>
          <button type="submit" className="mt-4 rounded-sf-control bg-sf-accent px-6 py-3 text-sm font-bold text-sf-on-accent hover:bg-sf-accent-hover" data-optout-confirm="">
            Don&apos;t ask me for reviews
          </button>
        </form>
      ) : (
        <p className="mt-3 text-sf-text-muted" data-optout-refused="">
          {OPTOUT_WORDS.refused}
        </p>
      )}
    </div>
  );
}
