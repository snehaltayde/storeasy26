import Link from "next/link";
import { platformConfigured } from "@/lib/platform/control";
import StackCalculator from "./StackCalculator";
import { STACK, HERO, GROUPS, CALC, SPEED, SAFETY, INDIA, GLOBAL, CLOSING, LINKS, claims } from "./landing-copy";

// The Storeasy landing page: "/" on a platform host (app/(storefront)/page.js).
// Server component; the calculator is the only client island. Every claim is
// in ./landing-copy.js with its source, held to docs/FEATURES.md by
// scripts/test-marketing.js. Plans are read from the same catalog /pricing
// shows and billing charges (lib/platform/billing.js), never written here.
// Edge-safe: billing.js and its imports reach no node:* module but
// tenant-context's async_hooks, which the edge runtime has.

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2";
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

function Bill({ from }) {
  return (
    <figure className="relative mx-auto w-full max-w-md lg:mx-0" aria-labelledby="bill-title">
      <div className="rounded-t-2xl bg-zinc-950 px-5 pt-6 pb-4 text-white shadow-[0_24px_60px_-30px_rgba(9,9,11,0.55)] sm:px-7">
        <figcaption id="bill-title" className="text-sm text-zinc-300">
          {HERO.billTitle}
        </figcaption>
        <table className="mt-4 w-full text-left text-sm">
          <thead className="sr-only">
            <tr>
              <th scope="col">{HERO.billApp}</th>
              <th scope="col">{HERO.billColumn}</th>
            </tr>
          </thead>
          <tbody>
            {STACK.map((row, i) => (
              <tr key={row.id} className="border-t border-dashed border-white/15">
                <th scope="row" className="py-2 pr-3 font-normal text-zinc-100">
                  {row.label}
                </th>
                <td className="py-2 text-right whitespace-nowrap">
                  <span className="mk-tick inline-flex items-center gap-1.5 font-mono text-xs text-lime-400" style={{ animationDelay: `${300 + i * 90}ms` }}>
                    <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3">
                      <path d="M2 6.5 5 9l5-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {HERO.billMark}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex items-baseline justify-between gap-4 border-t-2 border-white/80 pt-3">
          <span className="font-semibold">{HERO.billColumn}</span>
          <span className="font-mono text-sm text-lime-400">{!from ? HERO.billNoPlan : from.price === 0 ? HERO.billFree : `${HERO.billFrom} ${inr(from.price)}`}</span>
        </div>
      </div>
      {/* the torn edge of the bill */}
      <svg aria-hidden="true" viewBox="0 0 240 8" preserveAspectRatio="none" className="block h-2.5 w-full fill-zinc-950">
        <path d={`M0 0H240V0${Array.from({ length: 20 }, (_, i) => `L${240 - i * 12 - 6} 8L${240 - (i + 1) * 12} 0`).join("")}Z`} />
      </svg>
    </figure>
  );
}

function FactList({ items, cols = "sm:grid-cols-2" }) {
  return (
    <dl className={`grid gap-x-10 gap-y-6 ${cols}`}>
      {items.map((f) => (
        <div key={f.title} className="border-l-2 border-lime-600 pl-4">
          <dt className="font-semibold text-zinc-900">{f.title}</dt>
          <dd className="mt-1 text-[0.9375rem] leading-relaxed text-zinc-600">{f.body}</dd>
        </div>
      ))}
    </dl>
  );
}

const Section = ({ id, title, lede, children, className = "" }) => (
  <section id={id} aria-labelledby={`${id}-title`} className={`scroll-mt-20 py-16 sm:py-24 ${className}`}>
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <h2 id={`${id}-title`} className="max-w-2xl text-3xl font-extrabold tracking-tight text-balance text-zinc-950 sm:text-[2.5rem] sm:leading-[1.1]">
        {title}
      </h2>
      {lede && <p className="mt-4 max-w-xl text-lg text-zinc-600">{lede}</p>}
      <div className="mt-10 sm:mt-12">{children}</div>
    </div>
  </section>
);

export default async function MarketingHome() {
  const plans = await readPlans();
  const from = plans[0] || null; // listPlans sorts by price, lowest first
  const sourced = claims();

  return (
    <>
      <style>{`@keyframes mk-tick{from{opacity:0;transform:translateX(-4px)}to{opacity:1;transform:none}}.mk-tick{animation:mk-tick .35s ease-out both}@media (prefers-reduced-motion:reduce){.mk-tick{animation:none}}`}</style>

      <section className="border-b border-zinc-200 bg-zinc-50">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16 lg:py-24">
          <div>
            <h1 className="text-[2.5rem] leading-[1.02] font-extrabold tracking-[-0.035em] text-balance text-zinc-950 sm:text-6xl lg:text-[4.25rem]">{HERO.title}</h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-zinc-600">{HERO.lede}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/signup" className={`rounded-full bg-zinc-950 px-6 py-3 text-sm font-semibold text-white hover:bg-zinc-800 ${focus} focus-visible:outline-lime-700`}>
                {HERO.primary}
              </Link>
              <Link href="#calculator" className={`rounded-full border border-zinc-300 bg-white px-6 py-3 text-sm font-semibold text-zinc-900 hover:border-zinc-950 ${focus} focus-visible:outline-lime-700`}>
                {HERO.secondary}
              </Link>
            </div>
          </div>
          <Bill from={from} />
        </div>
      </section>

      <Section id="built-in" title={CLOSING.builtInTitle} lede={CLOSING.builtInLede}>
        <div className="space-y-14">
          {GROUPS.map((g) => (
            <div key={g.title} className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-12">
              <h3 className="text-lg font-bold text-zinc-950">{g.title}</h3>
              <FactList items={g.items} />
            </div>
          ))}
        </div>
      </Section>

      <Section id="calculator" title={CALC.title} lede={CALC.lede} className="border-y border-zinc-200 bg-zinc-50">
        <StackCalculator plans={plans} />
      </Section>

      <Section id="speed" title={SPEED.title}>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
          <FactList items={SPEED.items} />
          <aside aria-labelledby="measured-title" className="rounded-2xl border border-zinc-200 p-6">
            <h3 id="measured-title" className="font-bold text-zinc-950">
              {SPEED.measuredTitle}
            </h3>
            <ul className="mt-3 space-y-3 text-[0.9375rem] leading-relaxed text-zinc-700">
              {SPEED.measured.map((m) => (
                <li key={m.file}>{m.body}</li>
              ))}
            </ul>
            <p className="mt-4 text-sm text-zinc-600">{SPEED.measuredNote}</p>
          </aside>
        </div>
      </Section>

      <Section id="control" title={SAFETY.title} className="border-t border-zinc-200">
        <FactList items={SAFETY.items} cols="sm:grid-cols-2 lg:grid-cols-3" />
      </Section>

      <section aria-labelledby="checkout-title" className="bg-zinc-950 py-16 text-white sm:py-24">
        <div className="mx-auto grid max-w-6xl gap-12 px-4 sm:px-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-16">
          <div>
            <h2 id="checkout-title" className="text-3xl font-extrabold tracking-tight sm:text-[2.5rem] sm:leading-[1.1]">
              {INDIA.title}
            </h2>
            <dl className="mt-10 grid gap-x-10 gap-y-6 sm:grid-cols-2">
              {INDIA.items.map((f) => (
                <div key={f.title} className="border-l-2 border-lime-400 pl-4">
                  <dt className="font-semibold">{f.title}</dt>
                  <dd className="mt-1 text-[0.9375rem] leading-relaxed text-zinc-300">{f.body}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="lg:border-l lg:border-white/15 lg:pl-16">
            <h3 className="text-2xl font-extrabold tracking-tight">{GLOBAL.title}</h3>
            <p className="mt-4 text-[0.9375rem] leading-relaxed text-zinc-300">{GLOBAL.body}</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="closing-title" className="py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 id="closing-title" className="max-w-3xl text-4xl font-extrabold tracking-[-0.03em] text-balance text-zinc-950 sm:text-5xl">
            {CLOSING.title}
          </h2>
          <p className="mt-4 max-w-xl text-lg text-zinc-600">{CLOSING.body}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/signup" className={`rounded-full bg-zinc-950 px-6 py-3 text-sm font-semibold text-white hover:bg-zinc-800 ${focus} focus-visible:outline-lime-700`}>
              {CLOSING.primary}
            </Link>
            <Link href="/pricing" className={`rounded-full border border-zinc-300 px-6 py-3 text-sm font-semibold text-zinc-900 hover:border-zinc-950 ${focus} focus-visible:outline-lime-700`}>
              {CLOSING.secondary}
            </Link>
          </div>

          <nav aria-label={CLOSING.more} className="mt-14 border-t border-zinc-200 pt-8">
            <h3 className="text-sm font-semibold text-zinc-900">{CLOSING.more}</h3>
            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[0.9375rem]">
              {LINKS.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={`rounded text-zinc-700 underline decoration-zinc-300 underline-offset-4 hover:text-zinc-950 hover:decoration-zinc-950 ${focus} focus-visible:outline-lime-700`}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <details className="group mt-10 rounded-2xl border border-zinc-200 p-5 open:bg-zinc-50">
            <summary className={`cursor-pointer rounded font-semibold text-zinc-900 ${focus} focus-visible:outline-lime-700`}>{CLOSING.sources}</summary>
            <p className="mt-3 max-w-2xl text-sm text-zinc-600">{CLOSING.sourcesLede}</p>
            <ul className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              {sourced.map((c) => (
                <li key={c.title || c.body} className="min-w-0">
                  <span className="font-medium text-zinc-900">{c.title || GLOBAL.title}</span>
                  <span className="block truncate font-mono text-xs text-zinc-600" title={c.file || "docs/FEATURES.md"}>
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
