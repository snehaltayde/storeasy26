import { Fragment } from "react";
import Link from "next/link";
import { platformConfigured } from "@/lib/platform/control";
import StackCalculator from "./StackCalculator";
import MotionRoot from "./MotionRoot";
import { STACK, HERO, YOURS, SELL, CALC, SPEED, SAFETY, INDIA, GLOBAL, CLOSING, LINKS, claims } from "./landing-copy";
import "./landing.css";

// The Storeasy landing page: "/" on a platform host (app/(storefront)/page.js).
// Server component; the calculator and the motion island (MotionRoot) are the
// only client code. Every claim is in ./landing-copy.js with its source, held
// to docs/FEATURES.md by scripts/test-marketing.js; no words are written in
// this file. Plans are read from the same catalog /pricing shows and billing
// charges (lib/platform/billing.js), never written here.
// Look: ./landing.css on the .mk tokens (app/marketing.css), docs/UI.md.
// Motion: the markup is the finished page (every line struck, every block
// shown); MotionRoot rewinds it and plays it against the scroll, through the
// data attributes below. With motion off or no script this is what is read.
// Edge-safe: billing.js and its imports reach no node:* module but
// tenant-context's async_hooks, which the edge runtime has.

const ring = "focus-visible:outline-2 focus-visible:outline-offset-2";
const onPaper = `${ring} focus-visible:outline-mk-blue`;
const onInk = `${ring} focus-visible:outline-mk-sky`;
const pill = "inline-flex items-center justify-center rounded-full px-7 py-3.5 text-[0.9375rem] font-semibold";
const wrap = "mx-auto w-full max-w-[1680px] px-5 sm:px-8 lg:px-12";
const inr = (paise) => (paise === 0 ? "Free" : `₹${(paise / 100).toLocaleString("en-IN")}`);

async function readPlans() {
  if (!platformConfigured()) return [];
  try {
    const B = await import("@/lib/platform/billing.js");
    await B.ensureDefaultPlans();
    return (await B.listPlans()).map((p) => ({ id: p.id, name: p.name, price: p.price, interval: p.interval }));
  } catch {
    return [];
  }
}

const Tick = () => (
  <svg aria-hidden="true" viewBox="0 0 12 12" className="mk-tick">
    <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// The page's one bold thing: the app bill, as a paper receipt. Each rented app
// is struck through and answered by what Storeasy has in its place; the stamp
// lands, and the list folds into the last line, Storeasy's own price from the
// plan catalog. A list, not a table: each line has to fold shut.
function Bill({ from }) {
  const price = !from ? HERO.billNoPlan : from.price === 0 ? HERO.billFree : `${HERO.billFrom} ${inr(from.price)}`;
  return (
    <figure className="mk-receipt" aria-labelledby="bill-title">
      <div className="mk-paper" data-paper="">
        <div className="flex items-start justify-between gap-4">
          <figcaption id="bill-title" className="max-w-[13rem] text-base leading-snug font-semibold text-mk-navy">
            {HERO.billTitle}
          </figcaption>
          <span className="mk-stamp" data-stamp="">
            {HERO.billMark}
          </span>
        </div>
        <div className="mk-line-grid mk-cols" data-cols="" aria-hidden="true">
          <span>{HERO.billApp}</span>
          <span>{HERO.billColumn}</span>
        </div>
        <ul>
          {STACK.map((row) => (
            <li key={row.id} className="mk-line" data-line="">
              <div className="mk-line-grid">
                <span>
                  <span className="mk-strike" data-strike="">
                    {row.label}
                  </span>
                </span>
                <span className="mk-built" data-built="">
                  <Tick />
                  <span className="sr-only">{HERO.billColumn}: </span>
                  {row.built}
                </span>
              </div>
            </li>
          ))}
        </ul>
        <p className="mk-total" data-total="">
          <span>{HERO.billColumn}</span>
          <span className="tabular-nums">{price}</span>
        </p>
      </div>
    </figure>
  );
}

function Heading({ id, title, lede, ink = false, className = "" }) {
  return (
    <div className={className}>
      <h2 id={`${id}-title`} data-split="" className={`mk-h2 ${ink ? "text-white" : "text-mk-navy"}`}>
        {title}
      </h2>
      {lede ? (
        <p data-reveal="" className={`mt-6 max-w-[34rem] text-lg leading-relaxed sm:mt-8 ${ink ? "text-mk-on-ink" : "text-mk-body"}`}>
          {lede}
        </p>
      ) : null}
    </div>
  );
}

// Facts under a rule that draws itself: a definition list, not cards.
function FactList({ items, cols, ink = false }) {
  return (
    <dl className={`grid gap-x-10 gap-y-10 ${cols}`}>
      {items.map((f) => (
        <div key={f.title} data-reveal="">
          <div data-draw="" className={ink ? "mk-rule-ink" : "mk-hairline"} />
          <dt className={`mt-5 text-lg font-semibold ${ink ? "text-white" : "text-mk-navy"}`}>{f.title}</dt>
          <dd className={`mt-2 max-w-[30rem] text-[0.9375rem] leading-relaxed ${ink ? "text-mk-on-ink" : "text-mk-body"}`}>{f.body}</dd>
        </div>
      ))}
    </dl>
  );
}

// The speed section's picture: the line a page travels, drawn as you scroll,
// from the cached content through the Edge runtime to the shopper's screen.
// An ordered list, because it is a path.
function Path() {
  return (
    <figure aria-labelledby="flow-title" className="mk-path" data-path="">
      <figcaption id="flow-title" className="text-sm font-medium text-mk-sky">
        {SPEED.flowTitle}
      </figcaption>
      <div className="mk-path-row">
        <span aria-hidden="true" className="mk-path-track">
          <i data-path-fill="" />
          <b data-path-dot="" />
        </span>
        <ol>
          {SPEED.flow.map((label, i) => (
            <li key={label}>
              <span className="mk-node" data-node="">
                <svg aria-hidden="true" viewBox="0 0 16 16" className="h-5 w-5">
                  {i === 0 ? <path d="M2 4.5C2 3.1 4.7 2 8 2s6 1.1 6 2.5v7c0 1.4-2.7 2.5-6 2.5s-6-1.1-6-2.5v-7Zm0 0C2 5.9 4.7 7 8 7s6-1.1 6-2.5M2 8c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" fill="none" stroke="currentColor" strokeWidth="1.3" /> : null}
                  {i === 1 ? <path d="M9 1 3 9h4l-1 6 6-8H8l1-6Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /> : null}
                  {i === 2 ? <path d="M5 1.5h6a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Zm2 11h2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /> : null}
                </svg>
              </span>
              <span className="mk-path-label">{label}</span>
            </li>
          ))}
        </ol>
      </div>
    </figure>
  );
}

const Aurora = () => (
  <div aria-hidden="true" className="mk-aurora">
    <i />
    <i />
    <i />
  </div>
);

export default async function MarketingHome() {
  const plans = await readPlans();
  const from = plans[0] || null; // listPlans sorts by price, lowest first
  const sourced = claims();
  const words = HERO.title.split(" ");

  return (
    <div className="mk-home" data-mk-home="">
      <MotionRoot />

      {/* 1. The bill. From 1024px the stage holds still while the receipt is worked through. */}
      <section aria-labelledby="hero-title" className="mk-scene mk-stage mk-grain" data-scene="bill">
        <div className="mk-pin">
          <Aurora />
          <div className={`${wrap} mk-hero`}>
            <div className="mk-hero-copy">
              <h1 id="hero-title" className="mk-hero-title text-balance text-white">
                {words.map((word, i) => (
                  <Fragment key={`${word}-${i}`}>
                    <span className="mk-word">
                      <span style={{ "--i": i }}>{word}</span>
                    </span>{" "}
                  </Fragment>
                ))}
              </h1>
              <div>
                <p className="mk-fade max-w-[34rem] text-[1.0625rem] leading-relaxed text-mk-on-ink sm:text-lg" style={{ "--d": "620ms" }}>
                  {HERO.lede}
                </p>
                <div className="mk-fade mt-7 flex flex-wrap gap-3 sm:mt-8" style={{ "--d": "760ms" }}>
                  <Link href="/signup" data-magnetic="" className={`mk-cta-light ${pill} ${onInk}`}>
                    {HERO.primary}
                  </Link>
                  <Link href="#calculator" data-magnetic="" className={`mk-ghost ${pill} border border-white/30 text-white hover:border-white/60 hover:bg-white/10 ${onInk}`}>
                    {HERO.secondary}
                  </Link>
                </div>
              </div>
            </div>
            <Bill from={from} />
          </div>
        </div>
      </section>

      {/* 2. A storefront that's yours: the title holds while the list passes */}
      <section id="yours" aria-labelledby="yours-title" className="mk-sec scroll-mt-20">
        <div className={`${wrap} grid gap-12 lg:grid-cols-12 lg:gap-8`}>
          <div className="lg:col-span-5">
            <Heading id="yours" title={YOURS.title} lede={YOURS.lede} className="lg:sticky lg:top-28" />
          </div>
          <ul className="lg:col-span-6 lg:col-start-7">
            {YOURS.items.map((f) => (
              <li key={f.title} data-reveal="" className="mk-row">
                <div data-draw="" className="mk-hairline" />
                <h3 className="mk-h3 mt-6 text-mk-navy">{f.title}</h3>
                <p className="mt-3 max-w-[36rem] text-[1.0625rem] leading-relaxed text-mk-body">{f.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 3. Sell more: a rail. Swiped on phones, a grid at rest, driven sideways by the scroll from 768px. */}
      <section id="sell" aria-labelledby="sell-title" className="mk-scene mk-surface mk-grain scroll-mt-20" data-scene="rail">
        <div className="mk-pin">
          <div className="mk-rail" data-rail="">
            <Heading id="sell" title={SELL.title} lede={SELL.lede} ink className="mk-rail-intro" />
            <ul className="mk-rail-list">
              {SELL.items.map((f) => (
                <li key={f.title} className="mk-panel">
                  <h3 className="mk-h3 text-white">{f.title}</h3>
                  <p className="mt-4 text-[1.0625rem] leading-relaxed text-mk-on-ink">{f.body}</p>
                </li>
              ))}
            </ul>
            <p className="mk-rail-outro mk-display text-white">{SELL.all}</p>
          </div>
          <span aria-hidden="true" className="mk-rail-bar">
            <i data-rail-bar="" />
          </span>
        </div>
      </section>

      {/* 4. Checkout for India, and the note about selling beyond it */}
      <section id="checkout" aria-labelledby="checkout-title" className="mk-sec scroll-mt-20">
        <div className={`${wrap} grid gap-x-8 gap-y-12 lg:grid-cols-12 lg:gap-y-20`}>
          <Heading id="checkout" title={INDIA.title} lede={INDIA.lede} className="lg:col-span-7" />
          <aside aria-labelledby="global-title" data-clip="" className="mk-note mk-grain self-end lg:col-span-4 lg:col-start-9">
            <h3 id="global-title" className="mk-h3 text-white">
              {GLOBAL.title}
            </h3>
            <p className="mt-4 text-[0.9375rem] leading-relaxed text-mk-on-ink">{GLOBAL.body}</p>
          </aside>
          <div className="lg:col-span-12">
            <FactList items={INDIA.items} cols="sm:grid-cols-2 lg:grid-cols-4" />
          </div>
        </div>
      </section>

      {/* 5. Speed: the second navy stage, with the page's path drawn in light */}
      <section id="speed" aria-labelledby="speed-title" className="mk-stage mk-grain mk-sec scroll-mt-20">
        <Aurora />
        <div className={wrap}>
          <Heading id="speed" title={SPEED.title} ink className="max-w-[60rem]" />
          <Path />
          <FactList items={SPEED.items} cols="sm:grid-cols-2 lg:grid-cols-4" ink />
          <aside aria-labelledby="measured-title" data-reveal="" className="mt-16 grid gap-x-8 gap-y-4 border-t border-white/20 pt-8 lg:grid-cols-12">
            <h3 id="measured-title" className="font-semibold text-white lg:col-span-3">
              {SPEED.measuredTitle}
            </h3>
            <div className="lg:col-span-8 lg:col-start-5">
              <ul className="space-y-3 text-[0.9375rem] leading-relaxed text-mk-on-ink">
                {SPEED.measured.map((m) => (
                  <li key={m.file}>{m.body}</li>
                ))}
              </ul>
              <p className="mt-4 text-sm text-mk-on-ink">{SPEED.measuredNote}</p>
            </div>
          </aside>
        </div>
      </section>

      {/* 6. Control */}
      <section id="control" aria-labelledby="control-title" className="mk-sec scroll-mt-20">
        <div className={wrap}>
          <div className="grid lg:grid-cols-12">
            <Heading id="control" title={SAFETY.title} className="lg:col-span-8 lg:col-start-5" />
          </div>
          <div className="mt-14 sm:mt-20">
            <FactList items={SAFETY.items} cols="sm:grid-cols-2 lg:grid-cols-3" />
          </div>
        </div>
      </section>

      {/* 7. The founder's own sums */}
      <section id="calculator" aria-labelledby="calculator-title" className="mk-sec scroll-mt-20 bg-mk-mist">
        <div className={wrap}>
          <Heading id="calculator" title={CALC.title} lede={CALC.lede} className="max-w-[64rem]" />
          <div className="mt-12 sm:mt-16" data-reveal="">
            <StackCalculator plans={plans} />
          </div>
        </div>
      </section>

      {/* 8. Start */}
      <section aria-labelledby="closing-title" className="mk-sec">
        <div className={wrap}>
          <h2 id="closing-title" data-clip="" className="mk-h2 mk-closing mk-gradient-text">
            {CLOSING.title}
          </h2>
          <div className="mt-10 grid gap-8 lg:grid-cols-12" data-reveal="">
            <p className="max-w-[34rem] text-lg leading-relaxed text-mk-body lg:col-span-5">{CLOSING.body}</p>
            <div className="flex flex-wrap items-start gap-3 lg:col-span-6 lg:col-start-7">
              <Link href="/signup" data-magnetic="" className={`mk-cta ${pill} ${onPaper}`}>
                {CLOSING.primary}
              </Link>
              <Link href="/pricing" data-magnetic="" className={`mk-ghost ${pill} border border-mk-edge text-mk-navy hover:border-mk-navy hover:bg-mk-mist ${onPaper}`}>
                {CLOSING.secondary}
              </Link>
            </div>
          </div>

          <nav aria-label={CLOSING.more} className="mt-20 border-t border-mk-rule pt-8">
            <h3 className="text-sm font-semibold text-mk-navy">{CLOSING.more}</h3>
            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[0.9375rem]">
              {LINKS.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={`rounded text-mk-body underline decoration-mk-rule underline-offset-4 transition-colors hover:text-mk-violet hover:decoration-mk-violet ${onPaper}`}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <details className="mt-10 rounded-[1.25rem] border border-mk-rule p-5 open:bg-mk-mist sm:p-6">
            <summary className={`cursor-pointer rounded font-semibold text-mk-navy ${onPaper}`}>{CLOSING.sources}</summary>
            <p className="mt-3 max-w-2xl text-sm text-mk-body">{CLOSING.sourcesLede}</p>
            <ul className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {sourced.map((c) => (
                <li key={c.title || c.body} className="min-w-0">
                  <span className="font-medium text-mk-navy">{c.title || GLOBAL.title}</span>
                  <span className="block truncate font-mono text-xs text-mk-muted" title={c.file || "docs/FEATURES.md"}>
                    {c.file || "docs/FEATURES.md, ticked"}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </section>
    </div>
  );
}
