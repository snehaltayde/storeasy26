// Phase 9 line 1: the rating_summary primitive (Reviews' "Stars" block). A
// server component: no client code, no raw HTML. average is display text
// ("4.3") and count a whole number, both from approved reviews only; nothing
// shows while a product has no approved review.
import Stars from "./Stars";

export default function RatingSummary({ average, count = 0, link }) {
  if (!count || !average) return null;
  const words = `${average} out of 5, ${count} ${count === 1 ? "review" : "reviews"}`;
  const inner = (
    <>
      <Stars value={Number(average)} label={`${average} out of 5 stars`} />
      <span className="font-semibold text-sf-text">{average}</span>
      <span className="text-sf-text-muted">
        ({count} {count === 1 ? "review" : "reviews"})
      </span>
    </>
  );
  return link ? (
    <a href={link} className="sf-focus -my-2 inline-flex min-h-11 items-center gap-2 rounded-sf-small py-2 text-sm hover:underline sm:my-0 sm:min-h-0 sm:py-0" aria-label={words} data-rating-summary="">
      {inner}
    </a>
  ) : (
    <p className="inline-flex items-center gap-2 text-sm" data-rating-summary="">
      {inner}
    </p>
  );
}
