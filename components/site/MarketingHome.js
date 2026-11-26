import { Fragment } from "react";
import Link from "next/link";
import { platformConfigured } from "@/lib/platform/control";
import StackCalculator from "./StackCalculator";
import MotionRoot from "./MotionRoot";
import { ArtApps, ArtCheckout, ArtControl, ArtCopilot, ArtDefs, ArtFilters, ArtGlobe, ArtSell, ArtShop, ArtStack, ArtStudio, ArtThemes, Glyph, TierBars } from "./LandingArt";
import { ART, STACK, HERO, YOURS, SELL, CALC, PRICING, SPEED, SAFETY, INDIA, GLOBAL, CLOSING, LINKS, claims, typicalRupees, typicalTotal } from "./landing-copy";
import "./landing.css";

// The Storeasy landing page: "/" on a platform host (app/(storefront)/page.js).
// Server component; the calculator and the motion island (MotionRoot) are the
// only client code. Every claim is in ./landing-copy.js with its source, held
// to docs/FEATURES.md by scripts/test-marketing.js; no words are written in
// this file. Storeasy's plans are read from the same catalog /pricing shows
// and billing charges (lib/platform/billing.js), never written here; other
// apps' prices come from STACK in ./landing-copy.js, each with its source.
// Look (v4): every section is a picture first (./LandingArt.js) with a few
// words beside it. ./landing.css on the .mk tokens (app/marketing.css),
// docs/UI.md.
// Motion: the markup is the finished page (the deck resolved, every picture
// drawn); MotionRoot rewinds it and plays it against the scroll, through the
// data attributes below. With motion off or no script this is what is read.
// Edge-safe: billing.js and its imports reach no node:* module but
// tenant-context's async_hooks, which the edge runtime has.

const ring = "focus-visible:outline-2 focus-visible:outline-offset-2";
const onPaper = `${ring} focus-visible:outline-mk-blue`;
const onInk = `${ring} focus-visible:outline-mk-sky`;
const pill = "inline-flex items-center justify-center rounded-full px-7 py-3.5 text-[0.9375rem] font-semibold";
const wrap = "mx-auto w-full max-w-[1680px] px-5 sm:px-8 lg:px-12";
const rupees = (n) => `₹${Number(n).toLocaleString("en-IN")}`;
const inr = (paise) => rupees(paise / 100);
const count = (n) => Number(n).toLocaleString("en-IN");

async function readPlans() {
  if (!platformConfigured()) return { plans: [], enterprise: null };
  try {
    const B = await import("@/lib/platform/billing.js");
    await B.ensureDefaultPlans();
    const plans = (await B.listPublicPlans()).map((p) => ({ id: p.id, name: p.name, price: p.price, interval: p.interval, orders: p.features?.orders_per_month ?? null, seats: p.features?.staff_seats ?? null }));
    return { plans, enterprise: B.ENTERPRISE_PLAN };
  } catch {
    return { plans: [], enterprise: null };
  }
}

const Tick = () => (
  <svg aria-hidden="true" viewBox="0 0 12 12" className="mk-tick">
    <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// The page's one bold thing (v4b): the app bill as a dark glass deck. Rented
// apps queue at the top with their typical monthly price (STACK, sourced) and
// drop one by one into the Storeasy panel, where the built-in feature that
// replaces each one lands; two figures close it, the typical bill crossed out
// and the lowest plan from the catalog. The two lists are drawn so the picture
// is true at rest: the panel holds the first four features, the queue the
// three apps after them (both windows show the END of their list, and
// MotionRoot slides the lists down, so both are written last-first). They are
// decoration; the one list a screen reader gets is the whole bill, in order.
const SHOWN = 4;
const QUEUE = [...STACK.slice(0, SHOWN).reverse(), ...STACK.slice(SHOWN).reverse()];
const BUILT = [...STACK].reverse();

function Deck({ from }) {
  return (
    <figure className="mk-deck" aria-labelledby="bill-title" data-deck="">
      <div className="mk-deck-card">
        <div className="mk-deck-head">
          <figcaption id="bill-title">{HERO.billTitle}</figcaption>
        </div>
        <ul className="sr-only">
          {STACK.map((row) => (
            <li key={row.id}>
              {row.label}, {rupees(typicalRupees(row))} {CALC.unit}. {HERO.billColumn}: {row.built}.
            </li>
          ))}
        </ul>
        <div aria-hidden="true">
          <div className="mk-deck-view mk-deck-queue">
            <ul data-deck-queue="">
              {QUEUE.map((row) => (
                <li key={row.id}>
                  <span className="mk-chip">
                    <Glyph id={row.id} ink className="mk-glyph-sm" />
                    <span className="truncate">{row.label}</span>
                    <b>
                      {rupees(typicalRupees(row))}
                      <small>{HERO.billPer}</small>
                    </b>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <i className="mk-deck-beam" />
          <div className="mk-deck-panel">
            <p>
              {ART.stack}
              <span className="mk-deck-mark">
                <Tick />
                {HERO.billMark}
              </span>
            </p>
            <div className="mk-deck-view mk-deck-built">
              <ul data-deck-built="">
                {BUILT.map((row) => (
                  <li key={row.id}>
                    <Tick />
                    <span className="truncate">{row.built}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
        <Link href="#calculator" className={`mk-deck-more ${onInk}`}>
          {HERO.billMore}
        </Link>
        <div className="mk-deck-total">
          <p>
            <span>{HERO.billSum}</span>
            <span className="mk-deck-figure mk-deck-was">
              {rupees(typicalTotal())}
              <small aria-hidden="true">{HERO.billPer}</small>
              <i aria-hidden="true" />
            </span>
          </p>
          <svg aria-hidden="true" viewBox="0 0 32 16" className="mk-deck-arrow">
            <path d="M1 8h29m-6-6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="mk-deck-now">
            <span>
              {ART.stack} {from ? from.name : null}
            </span>
            <span className="mk-deck-figure">
              {from ? inr(from.price) : HERO.billNoPlan}
              {from ? <small aria-hidden="true">{HERO.billPer}</small> : null}
            </span>
          </p>
        </div>
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

// Facts as a short list, each with its own glyph: a definition list, not cards.
function FactList({ items, cols, ink = false }) {
  return (
    <dl className={`grid gap-x-8 gap-y-8 ${cols}`}>
      {items.map((f) => (
        <div key={f.title} data-reveal="" className="mk-fact">
          <Glyph id={f.id} ink={ink} />
          <div>
            <dt className={`text-base font-semibold ${ink ? "text-white" : "text-mk-navy"}`}>{f.title}</dt>
            <dd className={`mt-1 max-w-[26rem] text-[0.9375rem] leading-relaxed ${ink ? "text-mk-on-ink" : "text-mk-body"}`}>{f.body}</dd>
          </div>
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

const BENTO = { themes: ArtThemes, filters: ArtFilters, copilot: ArtCopilot, apps: ArtApps };

// One plan from the catalog: its size as bars, its price, its two limits.
function Plan({ plan, level }) {
  return (
    <li data-reveal="" className="mk-plan">
      <TierBars level={level} />
      <h3 className="mk-h3 mt-6 text-mk-navy">{plan.name}</h3>
      <p className="mt-3 flex flex-wrap items-baseline gap-x-2">
        <span className="mk-display text-[2.5rem] leading-none tabular-nums text-mk-navy">{inr(plan.price)}</span>
        <span className="text-sm text-mk-muted">{PRICING.perMonth}</span>
      </p>
      <ul className="mt-6 mb-8 flex-1 space-y-2.5 text-[0.9375rem] text-mk-body">
        {plan.orders == null ? null : (
          <li className="flex items-center gap-2.5">
            <Tick />
            {count(plan.orders)} {PRICING.orders}
          </li>
        )}
        {plan.seats == null ? null : (
          <li className="flex items-center gap-2.5">
            <Tick />
            {count(plan.seats)} {PRICING.seats}
          </li>
        )}
        <li className="flex items-center gap-2.5">
          <Tick />
          {PRICING.everything}
        </li>
      </ul>
      <Link href="/signup" className={`mk-ghost inline-flex w-full items-center justify-center rounded-full border border-mk-edge px-5 py-3 text-sm font-semibold text-mk-navy hover:border-mk-navy hover:bg-mk-mist ${onPaper}`}>
        {PRICING.choose} {plan.name}
      </Link>
    </li>
  );
}

export default async function MarketingHome() {
  const { plans, enterprise } = await readPlans();
  const from = plans[0] || null; // listPublicPlans sorts by price, lowest first
  const top = plans[plans.length - 1] || null;
  const sourced = claims();
  const words = HERO.title.split(" ");

  return (
    <div className="mk-home" data-mk-home="">
      <MotionRoot />
      <ArtDefs />

      {/* 1. The bill: one block of words beside the deck, inside the header pill's own frame */}
      <section aria-labelledby="hero-title" className="mk-stage mk-grain">
        <Aurora />
        <div className="mk-hero">
          <div className="mk-hero-copy">
            <p className="mk-eyebrow mk-fade">{HERO.eyebrow}</p>
            <h1 id="hero-title" className="mk-hero-title text-balance text-white">
              {words.map((word, i) => (
                <Fragment key={`${word}-${i}`}>
                  <span className="mk-word">
                    <span className={i + 2 < words.length ? "" : "text-mk-sky"} style={{ "--i": i }}>
                      {word}
                    </span>
                  </span>{" "}
                </Fragment>
              ))}
            </h1>
            <p className="mk-fade max-w-[33rem] text-[1.0625rem] leading-relaxed text-mk-on-ink sm:text-lg" style={{ "--d": "420ms" }}>
              {HERO.lede}
            </p>
            <div className="mk-fade flex flex-wrap gap-3 pt-1" style={{ "--d": "540ms" }}>
              <Link href="/signup" data-magnetic="" className={`mk-cta-light ${pill} ${onInk}`}>
                {HERO.primary}
              </Link>
              <Link href="#calculator" data-magnetic="" className={`mk-ghost ${pill} border border-white/30 text-white hover:border-white/60 hover:bg-white/10 ${onInk}`}>
                {HERO.secondary}
              </Link>
            </div>
          </div>
          <Deck from={from} />
        </div>
      </section>

      {/* 2. A storefront that's yours: the studio, drawn, then four smaller pictures */}
      <section id="yours" aria-labelledby="yours-title" className="mk-sec scroll-mt-24">
        <div className={wrap}>
          <div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-8">
            <div className="lg:col-span-5">
              <Heading id="yours" title={YOURS.title} lede={YOURS.lede} />
              <div data-reveal="" className="mk-fact mt-10">
                <Glyph id={YOURS.items[0].id} />
                <div>
                  <h3 className="text-base font-semibold text-mk-navy">{YOURS.items[0].title}</h3>
                  <p className="mt-1 max-w-[26rem] text-[0.9375rem] leading-relaxed text-mk-body">{YOURS.items[0].body}</p>
                </div>
              </div>
            </div>
            <div className="mk-a-pad lg:col-span-7">
              <ArtStudio />
            </div>
          </div>
          <ul className="mt-6 grid gap-6 sm:grid-cols-2 lg:mt-8 lg:grid-cols-4">
            {YOURS.items.slice(1).map((f) => {
              const Art = BENTO[f.id];
              return (
                <li key={f.title} data-reveal="" className="mk-bento">
                  <div className="mk-bento-art">
                    <Art />
                  </div>
                  <h3 className="mt-6 text-lg font-semibold text-mk-navy">{f.title}</h3>
                  <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-mk-body">{f.body}</p>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      {/* 3. Sell more: a rail of small pictures. Swiped on phones, a grid at rest, driven sideways by the scroll from 768px. */}
      <section id="sell" aria-labelledby="sell-title" className="mk-scene mk-surface mk-grain scroll-mt-24" data-scene="rail">
        <div className="mk-pin">
          <div className="mk-rail" data-rail="">
            <Heading id="sell" title={SELL.title} lede={SELL.lede} ink className="mk-rail-intro" />
            <ul className="mk-rail-list">
              {SELL.items.map((f) => (
                <li key={f.title} className="mk-panel">
                  <ArtSell id={f.id} />
                  <h3 className="mk-h3 mt-5 text-white">{f.title}</h3>
                  <p className="mt-3 text-[0.9375rem] leading-relaxed text-mk-on-ink">{f.body}</p>
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

      {/* 4. Checkout for India, drawn on a phone, and the note about selling beyond it */}
      <section id="checkout" aria-labelledby="checkout-title" className="mk-sec scroll-mt-24">
        <div className={`${wrap} grid items-center gap-x-8 gap-y-12 lg:grid-cols-12`}>
          <div className="lg:col-span-5">
            <Heading id="checkout" title={INDIA.title} lede={INDIA.lede} />
            <div className="mt-10">
              <FactList items={INDIA.items} cols="sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2" />
            </div>
          </div>
          <div className="mk-a-pad lg:col-span-6 lg:col-start-7">
            <ArtCheckout />
          </div>
          <aside aria-labelledby="global-title" data-clip="" className="mk-note mk-grain lg:col-span-12">
            <div className="max-w-[40rem]">
              <h3 id="global-title" className="mk-h3 text-white">
                {GLOBAL.title}
              </h3>
              <p className="mt-3 text-[0.9375rem] leading-relaxed text-mk-on-ink">{GLOBAL.body}</p>
            </div>
            <ArtGlobe />
          </aside>
        </div>
      </section>

      {/* 5. Speed: the second navy stage, with the page's path drawn in light */}
      <section id="speed" aria-labelledby="speed-title" className="mk-stage mk-grain mk-sec scroll-mt-24">
        <Aurora />
        <div className={wrap}>
          <Heading id="speed" title={SPEED.title} ink className="max-w-[60rem]" />
          <Path />
          <FactList items={SPEED.items} cols="sm:grid-cols-2 lg:grid-cols-4" ink />
          <aside aria-labelledby="measured-title" className="mt-16 border-t border-white/20 pt-8">
            <h3 id="measured-title" className="text-sm font-medium text-mk-sky">
              {SPEED.measuredTitle}
            </h3>
            <ul className="mt-6 grid gap-6 sm:grid-cols-2">
              {SPEED.measured.map((m) => (
                <li key={m.file} data-reveal="" className="mk-stat">
                  <p aria-hidden="true" className="mk-display mk-stat-figure">
                    {m.figure}
                  </p>
                  <p className="text-[0.9375rem] leading-relaxed text-mk-on-ink">{m.body}</p>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-sm text-mk-on-ink">{SPEED.measuredNote}</p>
          </aside>
        </div>
      </section>

      {/* 6. Control, as a diagram */}
      <section id="control" aria-labelledby="control-title" className="mk-sec scroll-mt-24">
        <div className={`${wrap} grid items-center gap-x-8 gap-y-12 lg:grid-cols-12`}>
          <div className="mk-a-pad lg:col-span-6">
            <ArtControl />
          </div>
          <div className="lg:col-span-5 lg:col-start-8">
            <Heading id="control" title={SAFETY.title} />
            <div className="mt-10">
              <FactList items={SAFETY.items} cols="sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2" />
            </div>
          </div>
        </div>
      </section>

      {/* 7. What the apps cost: the stack drawn into one, then the sums, then where each price was read */}
      <section id="calculator" aria-labelledby="calculator-title" className="mk-sec scroll-mt-24 bg-mk-mist">
        <div className={wrap}>
          <div className="grid items-center gap-x-8 gap-y-12 lg:grid-cols-12">
            <Heading id="calculator" title={CALC.title} lede={CALC.lede} className="lg:col-span-6" />
            <div className="lg:col-span-5 lg:col-start-8">
              <ArtStack caption={CALC.stackCaption} />
            </div>
          </div>
          <div className="mt-12 sm:mt-16" data-reveal="">
            <StackCalculator plans={plans} />
          </div>
          <details className="mt-12 rounded-[1.25rem] border border-mk-rule bg-white p-5 sm:p-6">
            <summary className={`cursor-pointer rounded font-semibold text-mk-navy ${onPaper}`}>{CALC.sources}</summary>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-mk-body">{CALC.sourcesLede}</p>
            <ul className="mt-5 grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {STACK.map((row) => (
                <li key={row.id} className="min-w-0">
                  <span className="font-semibold text-mk-navy">{row.label}</span>
                  <a href={row.price.url} rel="noopener noreferrer nofollow" target="_blank" className={`block rounded text-mk-violet underline decoration-mk-rule underline-offset-4 hover:decoration-mk-violet ${onPaper}`}>
                    {row.price.vendor}, {row.price.plan} {CALC.planWord}: {rupees(row.price.amount)}
                  </a>
                  <span className="block text-xs leading-relaxed text-mk-muted">
                    {row.price.basis === "vendor" ? CALC.vendorNote : CALC.listingNote} {CALC.checked} <time dateTime={row.price.checkedAt}>{new Date(`${row.price.checkedAt}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}</time>.
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </section>

      {/* 8. Plans, from the catalog billing charges from, then Enterprise */}
      <section id="plans" aria-labelledby="plans-title" className="mk-sec scroll-mt-24">
        <div className={wrap}>
          <Heading id="plans" title={PRICING.title} lede={PRICING.lede} className="max-w-[64rem]" />
          {plans.length === 0 ? (
            <p className="mt-10 text-mk-body">
              {PRICING.noPlans}{" "}
              <Link href="/pricing" className={`rounded font-semibold text-mk-violet underline underline-offset-4 ${onPaper}`}>
                {PRICING.more}
              </Link>
            </p>
          ) : (
            <ul className="mt-12 grid gap-5 sm:mt-16 sm:grid-cols-2 xl:grid-cols-4">
              {plans.map((p, i) => (
                <Plan key={p.id} plan={p} level={i + 1} />
              ))}
              {enterprise ? (
                <li data-reveal="" className="mk-plan mk-plan-ink mk-grain">
                  <TierBars level={4} ink />
                  <h3 className="mk-h3 mt-6 text-white">{enterprise.name}</h3>
                  <p className="mk-display mt-3 text-[2.5rem] leading-none text-white">{PRICING.enterprisePrice}</p>
                  <p className="mt-6 mb-8 flex-1 text-[0.9375rem] leading-relaxed text-mk-on-ink">
                    {top ? `${PRICING.enterpriseAbove} ${top.name}. ` : null}
                    {PRICING.enterpriseBody}
                  </p>
                  <Link href={enterprise.contact} className={`mk-cta-light inline-flex w-full items-center justify-center rounded-full px-5 py-3 text-sm font-semibold ${onInk}`}>
                    {PRICING.enterpriseCta}
                  </Link>
                </li>
              ) : null}
            </ul>
          )}
        </div>
      </section>

      {/* 9. Start */}
      <section aria-labelledby="closing-title" className="mk-sec pt-0">
        <div className={wrap}>
          <div className="grid items-center gap-x-8 gap-y-10 lg:grid-cols-12">
            <div className="lg:col-span-8">
              <h2 id="closing-title" data-clip="" className="mk-h2 mk-closing mk-gradient-text">
                {CLOSING.title}
              </h2>
              <div className="mt-10" data-reveal="">
                <p className="max-w-[34rem] text-lg leading-relaxed text-mk-body">{CLOSING.body}</p>
                <div className="mt-8 flex flex-wrap items-start gap-3">
                  <Link href="/signup" data-magnetic="" className={`mk-cta ${pill} ${onPaper}`}>
                    {CLOSING.primary}
                  </Link>
                  <Link href="/pricing" data-magnetic="" className={`mk-ghost ${pill} border border-mk-edge text-mk-navy hover:border-mk-navy hover:bg-mk-mist ${onPaper}`}>
                    {CLOSING.secondary}
                  </Link>
                </div>
              </div>
            </div>
            <div className="lg:col-span-4">
              <ArtShop />
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
