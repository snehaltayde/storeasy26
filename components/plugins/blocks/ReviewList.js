// Phase 9 line 1: the review_list primitive (Reviews' "Reviews" block). A
// server component: no client code, no raw HTML. Every word is plain text
// that React escapes; the reviews are approved ones only, newest first, with
// the store's reply when the founder shows replies. id="reviews" is where the
// Stars link lands.
import Link from "next/link";
import Stars from "./Stars";

const dateText = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
};

export function ReviewItems({ reviews = [] }) {
  return (
    <ul className="divide-y divide-sf-border-soft border-y border-sf-border-soft">
      {reviews.map((r, i) => (
        <li key={i} className="py-5" data-review="">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Stars value={r.rating} label={`${r.rating} out of 5 stars`} />
            {r.title ? <p className="font-semibold text-sf-text">{r.title}</p> : null}
          </div>
          <p className="mt-2 whitespace-pre-line text-sm text-sf-text-body">{r.body}</p>
          <p className="mt-2 text-xs text-sf-text-faint">
            {r.name} · Verified buyer{r.date ? ` · ${dateText(r.date)}` : ""}
          </p>
          {r.reply ? (
            <div className="mt-3 rounded-sf-card bg-sf-surface-muted p-3 text-sm" data-review-reply="">
              <p className="font-semibold text-sf-text">Reply from the store</p>
              <p className="mt-1 whitespace-pre-line text-sf-text-muted">{r.reply}</p>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function Distribution({ distribution = [], count = 0 }) {
  return (
    <ul className="space-y-1.5" aria-label="How many reviews gave each number of stars">
      {distribution.map((d) => {
        const pct = count ? Math.round((d.count / count) * 100) : 0;
        return (
          <li key={d.stars} className="flex items-center gap-2 text-xs text-sf-text-muted">
            <span className="w-12 shrink-0">{d.stars} {d.stars === 1 ? "star" : "stars"}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-sf-surface-muted" aria-hidden="true">
              <span className="block h-full rounded-full bg-sf-accent" style={{ width: `${pct}%` }} />
            </span>
            <span className="w-8 shrink-0 text-right">{d.count}</span>
          </li>
        );
      })}
    </ul>
  );
}

export default function ReviewList({ average, count = 0, distribution = [], reviews = [], see_all: seeAll }) {
  if (!count || !reviews.length) return null;
  return (
    <section id="reviews" className="scroll-mt-24" data-review-list="">
      <h2 className="text-lg font-semibold text-sf-text">Reviews</h2>
      <div className="mt-4 grid gap-6 sm:grid-cols-[14rem_1fr]">
        <div>
          <p className="flex items-center gap-2">
            <span className="text-3xl font-semibold text-sf-text">{average}</span>
            <Stars value={Number(average)} size={18} label={`${average} out of 5 stars`} />
          </p>
          <p className="mt-1 text-sm text-sf-text-muted">
            {count} {count === 1 ? "review" : "reviews"}
          </p>
          <div className="mt-4">
            <Distribution distribution={distribution} count={count} />
          </div>
        </div>
        <div>
          <ReviewItems reviews={reviews} />
          {seeAll ? (
            <Link href={seeAll} className="mt-4 inline-block text-sm font-semibold text-sf-accent-text underline" data-review-see-all="">
              See all reviews
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}
