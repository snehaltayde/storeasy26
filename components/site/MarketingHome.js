import { Fragment } from "react";
import Link from "next/link";
import { platformConfigured } from "@/lib/platform/control";
import StackCalculator from "./StackCalculator";
import MotionRoot from "./MotionRoot";
import { STACK, HERO, GROUPS, CALC, SPEED, SAFETY, INDIA, GLOBAL, CLOSING, LINKS, claims } from "./landing-copy";

// The Storeasy landing page: "/" on a platform host (app/(storefront)/page.js).
// Server component; the calculator and the motion island (MotionRoot, which
// draws nothing) are the only client code. Every claim is in ./landing-copy.js
// with its source, held to docs/FEATURES.md by scripts/test-marketing.js; no
// words are written in this file. Plans are read from the same catalog
// /pricing shows and billing charges (lib/platform/billing.js), never written
// here. Look and motion: app/marketing.css (.mk tokens), docs/UI.md.
// Edge-safe: billing.js and its imports reach no node:* module but
// tenant-context's async_hooks, which the edge runtime has.

const ring = "focus-visible:outline-2 focus-visible:outline-offset-2";
const onPaper = `${ring} focus-visible:outline-mk-blue`;
const onInk = `${ring} focus-visible:outline-mk-sky`;
const pill = "inline-flex items-center justify-center rounded-full px-7 py-3.5 text-[0.9375rem] font-semibold";
const wrap = "mx-auto max-w-6xl px-4 sm:px-6";
const h2 = "mk-display max-w-3xl text-[2.25rem] leading-[1.06] text-balance sm:text-5xl lg:text-[3.5rem]";
const inr = (paise) => (paise === 0 ? "Free" : `₹${(paise / 100).toLocaleString("en-IN")}`);

// How wide each tile of a group sits on the six-column bento, by group size.
const SPANS = {
  1: ["lg:col-span-6"],
  3: ["lg:col-span-2", "lg:col-span-2", "lg:col-span-2"],
  4: ["lg:col-span-4", "lg:col-span-2", "lg:col-span-2", "lg:col-span-4"],
  5: ["lg:col-span-3", "lg:col-span-3", "lg:col-span-2", "lg:col-span-2", "lg:col-span-2"],
};

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
  <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3">
    <path d="M2 6.5 5 9l5-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Spark = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="mx-7 h-3.5 w-3.5 shrink-0 text-mk-blue sm:mx-10">
    <path d="M8 0c.6 4.4 3.6 7.4 8 8-4.4.6-7.4 3.6-8 8-.6-4.4-3.6-7.4-8-8 4.4-.6 7.4-3.6 8-8Z" fill="currentColor" />
  </svg>
);

// The hero's one bold thing: the app bill. Each rented app is struck through
// in turn and marked "Built in"; the last line is Storeasy's own price, read
// from the plan catalog.
function Bill({ from }) {
  const price = !from ? HERO.billNoPlan : from.price === 0 ? HERO.billFree : `${HERO.billFrom} ${inr(from.price)}`;
  return (
    <div className="relative mx-auto w-full max-w-md lg:mx-0 lg:justify-self-end">
      <figure data-parallax="-0.05" className="mk-bill px-5 pt-6 pb-5 sm:px-7" aria-labelledby="bill-title">
        <figcaption id="bill-title" className="text-sm font-medium text-mk-sky">
          {HERO.billTitle}
        </figcaption>
        <table className="mt-4 w-full text-left text-[0.9375rem]">
          <thead className="sr-only">
            <tr>
              <th scope="col">{HERO.billApp}</th>
              <th scope="col">{HERO.billColumn}</th>
            </tr>
          </thead>
          <tbody>
            {STACK.map((row, i) => (
              <tr key={row.id} className="border-t border-white/10">
                <th scope="row" className="py-2.5 pr-3 font-normal">
                  <span className="mk-strike" style={{ "--i": i }}>
                    {row.label}
                  </span>
                </th>
                <td className="py-2.5 text-right whitespace-nowrap">
                  <span className="mk-built inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold text-white" style={{ "--i": i }}>
                    <Tick />
                    {HERO.billMark}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mk-total mt-3 flex items-baseline justify-between gap-4 rounded-2xl bg-white px-4 py-3.5 text-mk-navy" style={{ "--i": STACK.length }}>
          <span className="font-semibold">{HERO.billColumn}</span>
          <span className="font-semibold tabular-nums">{price}</span>
        </div>
      </figure>
    </div>
  );
}

function FactList({ items, cols = "sm:grid-cols-2", ink = false }) {
  return (
    <dl className={`grid gap-x-10 gap-y-9 ${cols}`}>
      {items.map((f, i) => (
        <div key={f.title} data-reveal="" style={{ "--d": `${(i % 3) * 90}ms` }}>
          <div className={ink ? "h-px bg-white/20" : "mk-hairline"} />
          <dt className={`mt-5 text-lg font-semibold ${ink ? "text-white" : "text-mk-navy"}`}>{f.title}</dt>
          <dd className={`mt-2 text-[0.9375rem] leading-relaxed ${ink ? "text-mk-on-ink" : "text-mk-body"}`}>{f.body}</dd>
        </div>
      ))}
    </dl>
  );
}

function Heading({ id, title, lede, ink = false }) {
  return (
    <div data-reveal="">
      <h2 id={`${id}-title`} className={`${h2} ${ink ? "text-white" : "text-mk-navy"}`}>
        {title}
      </h2>
      {lede ? <p className={`mt-5 max-w-xl text-lg leading-relaxed ${ink ? "text-mk-on-ink" : "text-mk-body"}`}>{lede}</p> : null}
    </div>
  );
}

// The speed band's picture: a light runs from the cached content, through the
// Edge runtime, to the shopper's screen. An ordered list, because it is a path.
function Flow() {
  return (
    <figure aria-labelledby="flow-title" className="mk-glass-dark p-6 sm:p-8" data-reveal="">
      <figcaption id="flow-title" className="text-sm font-medium text-mk-sky">
        {SPEED.flowTitle}
      </figcaption>
      <ol className="mk-flow mt-7">
        {SPEED.flow.map((label, i) => (
          <li key={label} className="text-center">
            <span className="mk-node" style={{ "--i": i }}>
              <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4">
                {i === 0 ? <path d="M2 4.5C2 3.1 4.7 2 8 2s6 1.1 6 2.5v7c0 1.4-2.7 2.5-6 2.5s-6-1.1-6-2.5v-7Zm0 0C2 5.9 4.7 7 8 7s6-1.1 6-2.5M2 8c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" fill="none" stroke="currentColor" strokeWidth="1.3" /> : null}
                {i === 1 ? <path d="M9 1 3 9h4l-1 6 6-8H8l1-6Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /> : null}
                {i === 2 ? <path d="M5 1.5h6a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Zm2 11h2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /> : null}
              </svg>
            </span>
            <span className="mt-3 block text-sm font-medium text-white">{label}</span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

export default async function MarketingHome() {
  const plans = await readPlans();
  const from = plans[0] || null; // listPlans sorts by price, lowest first
  const sourced = claims();
  const words = HERO.title.split(" ");

  return (
    <>
      <MotionRoot />

      {/* Hero: a navy stage set into the white page, the aurora behind it */}
      <section aria-labelledby="hero-title" className="px-2 pt-2 sm:px-3 sm:pt-3">
        <div className="mk-stage mk-grain mx-auto max-w-[1680px] rounded-[1.75rem] sm:rounded-[2.25rem]">
          <div aria-hidden="true" className="mk-aurora">
            <i />
            <i />
            <i />
          </div>
          <div className={`${wrap} grid items-center gap-14 py-16 sm:py-20 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16 lg:py-28`}>
            <div>
              <h1 id="hero-title" className="text-[2.75rem] leading-[1.02] text-balance text-white sm:text-6xl lg:text-[4.75rem]">
                {words.map((word, i) => (
                  <Fragment key={`${word}-${i}`}>
                    <span className="mk-word">
                      <span style={{ "--i": i }}>{word}</span>
                    </span>{" "}
                  </Fragment>
                ))}
              </h1>
              <p className="mk-fade mt-7 max-w-xl text-lg leading-relaxed text-mk-on-ink" style={{ "--d": "700ms" }}>
                {HERO.lede}
              </p>
              <div className="mk-fade mt-9 flex flex-wrap gap-3" style={{ "--d": "850ms" }}>
                <Link href="/signup" data-magnetic="" className={`mk-cta-light ${pill} ${onInk}`}>
                  {HERO.primary}
                </Link>
                <Link href="#calculator" data-magnetic="" className={`mk-ghost ${pill} border border-white/30 text-white hover:border-white/60 hover:bg-white/10 ${onInk}`}>
                  {HERO.secondary}
                </Link>
              </div>
            </div>
            <Bill from={from} />
          </div>
        </div>
      </section>

      {/* What is built in, passing by. The second copy only fills the loop. */}
      <section aria-label={HERO.billMark} className="mk-band py-10 sm:py-14">
        <div className="mk-marquee">
          <div className="mk-marquee-track">
            {[0, 1].map((copy) => (
              <ul key={copy} aria-hidden={copy === 1 ? "true" : undefined} className="flex shrink-0 items-center">
                {STACK.map((row) => (
                  <li key={row.id} className="mk-display flex items-center text-2xl whitespace-nowrap text-mk-navy sm:text-[2rem]">
                    {row.built}
                    <Spark />
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </div>
        <div className={`${wrap} mt-6 flex justify-end`}>
          <label className="mk-pause">
            <input type="checkbox" className="sr-only" />
            <span className="sr-only">{CLOSING.pause}</span>
            <svg aria-hidden="true" viewBox="0 0 12 12" className="mk-hold h-3 w-3">
              <path d="M3 2v8M9 2v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <svg aria-hidden="true" viewBox="0 0 12 12" className="mk-play h-3 w-3">
              <path d="M3.5 1.8v8.4L10 6 3.5 1.8Z" fill="currentColor" />
            </svg>
          </label>
        </div>
      </section>

      {/* Built in: a glass bento, one block for each job it does */}
      <section id="built-in" aria-labelledby="built-in-title" className="relative isolate scroll-mt-20 bg-mk-mist py-20 sm:py-28">
        <div aria-hidden="true" className="mk-wash">
          <i data-parallax="0.08" />
          <i data-parallax="-0.1" />
        </div>
        <div className={wrap}>
          <Heading id="built-in" title={CLOSING.builtInTitle} lede={CLOSING.builtInLede} />
          <div className="mt-14 space-y-16 sm:mt-16">
            {GROUPS.map((g) => (
              <div key={g.title}>
                <h3 data-reveal="" className="mk-display text-[1.75rem] leading-tight text-mk-navy">
                  {g.title}
                </h3>
                <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
                  {g.items.map((f, i) => (
                    <li key={f.title} data-reveal="" style={{ "--d": `${(i % 3) * 80}ms` }} className={(SPANS[g.items.length] || [])[i] || "lg:col-span-2"}>
                      <div data-spot="" className="mk-glass h-full p-6 sm:p-7">
                        <h4 className="text-lg font-semibold text-mk-navy">{f.title}</h4>
                        <p className="mt-2 text-[0.9375rem] leading-relaxed text-mk-body">{f.body}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="calculator" aria-labelledby="calculator-title" className="scroll-mt-20 py-20 sm:py-28">
        <div className={wrap}>
          <Heading id="calculator" title={CALC.title} lede={CALC.lede} />
          <div className="mt-12 sm:mt-14" data-reveal="">
            <StackCalculator plans={plans} />
          </div>
        </div>
      </section>

      {/* Speed: the second navy band, with the page's path drawn in light */}
      <section id="speed" aria-labelledby="speed-title" className="mk-stage mk-grain scroll-mt-20 py-20 sm:py-28">
        <div aria-hidden="true" className="mk-aurora opacity-60">
          <i />
          <i />
          <i />
        </div>
        <div className={wrap}>
          <Heading id="speed" title={SPEED.title} ink />
          <div className="mt-12 grid gap-12 sm:mt-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] lg:gap-16">
            <FactList items={SPEED.items} ink />
            <div className="space-y-5">
              <Flow />
              <aside aria-labelledby="measured-title" className="mk-glass-dark p-6 sm:p-8" data-reveal="" style={{ "--d": "120ms" }}>
                <h3 id="measured-title" className="font-semibold text-white">
                  {SPEED.measuredTitle}
                </h3>
                <ul className="mt-3 space-y-3 text-[0.9375rem] leading-relaxed text-mk-on-ink">
                  {SPEED.measured.map((m) => (
                    <li key={m.file}>{m.body}</li>
                  ))}
                </ul>
                <p className="mt-4 text-sm text-mk-on-ink">{SPEED.measuredNote}</p>
              </aside>
            </div>
          </div>
        </div>
      </section>

      <section id="control" aria-labelledby="control-title" className="scroll-mt-20 py-20 sm:py-28">
        <div className={wrap}>
          <Heading id="control" title={SAFETY.title} />
          <div className="mt-12 sm:mt-14">
            <FactList items={SAFETY.items} cols="sm:grid-cols-2 lg:grid-cols-3" />
          </div>
        </div>
      </section>

      {/* Checkout: the signature gradient as a surface */}
      <section aria-labelledby="checkout-title" className="px-2 sm:px-3">
        <div className="mk-surface mk-grain mx-auto max-w-[1680px] rounded-[1.75rem] py-16 sm:rounded-[2.25rem] sm:py-24">
          <div className={`${wrap} grid gap-12 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-16`}>
            <div>
              <Heading id="checkout" title={INDIA.title} ink />
              <div className="mt-12">
                <FactList items={INDIA.items} ink />
              </div>
            </div>
            <aside aria-labelledby="global-title" className="mk-glass-dark self-start p-6 sm:p-8" data-reveal="" style={{ "--d": "120ms" }}>
              <h3 id="global-title" className="mk-display text-[1.75rem] leading-tight text-white">
                {GLOBAL.title}
              </h3>
              <p className="mt-4 text-[0.9375rem] leading-relaxed text-mk-on-ink">{GLOBAL.body}</p>
            </aside>
          </div>
        </div>
      </section>

      <section aria-labelledby="closing-title" className="relative isolate py-20 sm:py-28">
        <div className={wrap}>
          <div data-reveal="">
            <h2 id="closing-title" className="mk-display mk-gradient-text max-w-4xl text-[2.75rem] leading-[1.04] text-balance sm:text-6xl lg:text-[4.5rem]">
              {CLOSING.title}
            </h2>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-mk-body">{CLOSING.body}</p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link href="/signup" data-magnetic="" className={`mk-cta ${pill} ${onPaper}`}>
                {CLOSING.primary}
              </Link>
              <Link href="/pricing" data-magnetic="" className={`mk-ghost ${pill} border border-mk-edge text-mk-navy hover:border-mk-navy hover:bg-mk-mist ${onPaper}`}>
                {CLOSING.secondary}
              </Link>
            </div>
          </div>

          <nav aria-label={CLOSING.more} className="mt-16 border-t border-mk-rule pt-8">
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
            <ul className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
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
    </>
  );
}
