import { BadgePercent, BookUser, Calculator, CalendarClock, Check, CreditCard, Database, FilePen, Gauge, Globe, Image as Picture, KeyRound, LayoutTemplate, ListChecks, Lock, MapPin, MessageCircle, MousePointer2, Palette, Repeat, ScrollText, Search, Server, ShieldCheck, ShoppingCart, SlidersHorizontal, Sparkles, Star, Tags, Truck, Type, Users, Wallet, Webhook, Zap } from "lucide-react";
import { ART, STACK } from "./landing-copy";

// The landing page's artwork (v4): every section's picture, drawn by hand in
// markup and inline SVG in the brand's own colours. No image file, no request.
// It is decoration: each piece is aria-hidden, and the words drawn inside it
// come from ART in ./landing-copy.js so the copy scan reads them too.
// Like the rest of the page, the markup is the finished picture; MotionRoot
// rewinds it and plays it as it scrolls into view, through four attributes:
//   data-art      a picture: its parts arrive when it reaches the window
//   data-pop      a part that rises into place
//   data-stroke   an SVG line that draws itself (pathLength is 1)
//   data-grow     a bar or a stretched line that fills from the left ("end": from the right)
// What loops (a bob, a caret, a pulse) is a CSS animation in landing.css, so
// reduced motion stops it with everything else.

// Small glyphs for lists and the header's menu: one per idea, by id.
const GLYPHS = {
  studio: LayoutTemplate, themes: Palette, filters: SlidersHorizontal, copilot: Sparkles, apps: Webhook,
  offers: Tags, nudges: ShoppingCart, schedule: CalendarClock, subscribe: Repeat, quiz: ListChecks, ratings: Star, whatsapp: MessageCircle, delivery: Truck,
  pay: CreditCard, nudge: BadgePercent, pin: MapPin, address: BookUser,
  edge: Zap, server: Server, fonts: Type, images: Picture,
  shopify: Lock, drafts: FilePen, database: Database, roles: Users, audit: ScrollText, totals: Calculator,
  checkout: Wallet, speed: Gauge, control: ShieldCheck,
  subscriptions: Repeat, shipping: Truck, bundles: Tags, cart: ShoppingCart, search: Search, builder: LayoutTemplate, cod: Wallet, markets: Globe, ai: Sparkles,
};

export function Glyph({ id, ink = false, className = "" }) {
  const Icon = GLYPHS[id] || Sparkles;
  return (
    <span aria-hidden="true" className={`mk-glyph ${ink ? "mk-glyph-ink" : ""} ${className}`}>
      <Icon strokeWidth={1.6} className="h-[1.15rem] w-[1.15rem]" />
    </span>
  );
}

const card = "rounded-2xl border border-mk-rule bg-white shadow-[0_28px_60px_-36px_rgb(11_6_86/0.55)]";
const chip = "rounded-full px-2.5 py-1 text-[0.6875rem] leading-none font-semibold";
const line = "block h-1.5 rounded-full";
const three = [0, 1, 2];
const five = [0, 1, 2, 3, 4];

// Gradients the SVG pictures share, defined once at the top of the page.
export function ArtDefs() {
  return (
    <svg aria-hidden="true" width="0" height="0" className="absolute">
      <defs>
        <linearGradient id="mk-g-sig" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0b0656" />
          <stop offset="1" stopColor="#5b2be0" />
        </linearGradient>
        <linearGradient id="mk-g-light" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#5b2be0" />
          <stop offset="0.55" stopColor="#2f7bff" />
          <stop offset="1" stopColor="#9cc0ff" />
        </linearGradient>
      </defs>
    </svg>
  );
}

// 2a. The studio: a section list, a canvas, a block in mid-drag, the tokens.
export function ArtStudio() {
  return (
    <div aria-hidden="true" data-art="" className="mk-art">
      <div data-pop="" className={`${card} overflow-hidden`}>
        <div className="flex items-center gap-2 border-b border-mk-rule px-4 py-3">
          <span className="flex gap-1.5">
            {three.map((i) => (
              <i key={i} className="block h-2.5 w-2.5 rounded-full bg-mk-rule" />
            ))}
          </span>
          <i className="ml-2 block h-6 flex-1 rounded-full bg-mk-mist" />
          <span className={`${chip} border border-mk-rule text-mk-muted`}>{ART.studio.draft}</span>
          <span className={`${chip} mk-a-sig text-white`}>{ART.studio.publish}</span>
        </div>
        <div className="grid grid-cols-[6.75rem_minmax(0,1fr)] sm:grid-cols-[9rem_minmax(0,1fr)_5rem]">
          <ul className="space-y-2 border-r border-mk-rule p-3">
            {ART.studio.sections.map((s, i) => (
              <li key={s} data-pop="" className={`flex items-center gap-2 rounded-lg px-2 py-2 text-xs font-medium ${i === 2 ? "bg-mk-violet/10 text-mk-violet ring-1 ring-mk-violet/40" : "bg-mk-mist text-mk-body"}`}>
                <i className="mk-a-grip" />
                {s}
              </li>
            ))}
          </ul>
          <div className="relative space-y-3 p-3 sm:p-4">
            <div data-pop="" className="mk-a-sig flex h-24 flex-col justify-end gap-2 rounded-xl p-4 sm:h-36">
              <i className={`${line} h-2 w-2/3 bg-white/90`} />
              <i className={`${line} h-2 w-1/3 bg-white/50`} />
            </div>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              {three.map((i) => (
                <div key={i} data-pop="" className="space-y-2 rounded-xl bg-mk-mist p-2">
                  <i className="block aspect-[4/3] rounded-lg bg-white" />
                  <i className={`${line} w-3/4 bg-mk-rule`} />
                </div>
              ))}
            </div>
            <div data-pop="" className="mk-a-drag">
              <div className="mk-bob flex items-center gap-3 rounded-xl border border-mk-violet bg-white px-3.5 py-3 shadow-[0_22px_40px_-18px_rgb(91_43_224/0.75)]">
                <i className="mk-a-grip" />
                <span className="flex gap-0.5 text-mk-violet">
                  {five.map((i) => (
                    <Star key={i} fill="currentColor" strokeWidth={0} className="h-3.5 w-3.5" />
                  ))}
                </span>
                <i className={`${line} w-12 bg-mk-rule`} />
                <MousePointer2 fill="#0b0656" strokeWidth={1.5} className="absolute -right-2 -bottom-3 h-5 w-5 text-white" />
              </div>
            </div>
          </div>
          <div className="hidden space-y-4 border-l border-mk-rule p-3 sm:block">
            <div className="grid grid-cols-2 gap-2">
              {["bg-mk-navy", "bg-mk-violet", "bg-mk-blue", "bg-mk-sky"].map((c) => (
                <i key={c} data-pop="" className={`block aspect-square rounded-full ${c}`} />
              ))}
            </div>
            {[70, 40, 55].map((w) => (
              <span key={w} className="relative block h-1.5 rounded-full bg-mk-rule">
                <i data-grow="" className="mk-a-light absolute inset-y-0 left-0 rounded-full" style={{ width: `${w}%` }} />
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// 2b. Five themes, fanned like a hand of cards.
const THEMES = [
  ["#0b0656", "#9cc0ff"],
  ["#2a14a0", "#d9d2ff"],
  ["#5b2be0", "#ece9ff"],
  ["#2f7bff", "#e3eeff"],
  ["#070530", "#5b2be0"],
];
export function ArtThemes() {
  return (
    <div aria-hidden="true" data-art="" className="mk-art mk-a-fan">
      {THEMES.map(([top, tint], i) => (
        <div key={top} data-pop="" className="mk-a-fan-card" style={{ "--n": i - 2 }}>
          <i className="block h-9 rounded-md" style={{ background: top }} />
          <i className="mt-1.5 block h-5 rounded-md" style={{ background: tint }} />
          <span className="mt-1.5 grid grid-cols-2 gap-1.5">
            <i className="block h-6 rounded-md bg-mk-mist" />
            <i className="block h-6 rounded-md bg-mk-mist" />
          </span>
        </div>
      ))}
    </div>
  );
}

// 2c. Filters: a search bar, chips switched on, the results that stay.
export function ArtFilters() {
  return (
    <div aria-hidden="true" data-art="" className="mk-art space-y-3">
      <div data-pop="" className="flex items-center gap-2 rounded-full border border-mk-rule bg-white px-3.5 py-2.5">
        <Search strokeWidth={1.8} className="h-4 w-4 text-mk-violet" />
        <i className={`${line} w-24 bg-mk-rule`} />
        <i className="mk-caret" />
      </div>
      <div className="flex flex-wrap gap-2">
        {ART.filters.map((f, i) => (
          <span key={f} data-pop="" className={`${chip} inline-flex items-center gap-1 ${i === 1 ? "border border-mk-rule bg-white text-mk-body" : "mk-a-sig text-white"}`}>
            {i === 1 ? null : <Check strokeWidth={3} className="h-3 w-3" />}
            {f}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {[true, false, true, false].map((kept, i) => (
          <span key={i} data-pop="" className="block">
            <i className={`block aspect-[3/4] rounded-xl border border-mk-rule bg-white ${kept ? "" : "opacity-30"}`} />
          </span>
        ))}
      </div>
    </div>
  );
}

// 2d. The copilot: a request, and the draft it writes. A draft, never live.
export function ArtCopilot() {
  return (
    <div aria-hidden="true" data-art="" className="mk-art space-y-3">
      <div data-pop="" className="mk-a-sig ml-auto flex w-fit max-w-full items-center gap-2 rounded-2xl rounded-br-md px-3.5 py-2.5 text-xs font-medium text-white">
        <Sparkles strokeWidth={1.8} className="h-4 w-4 flex-none text-mk-sky" />
        {ART.copilot.ask}
      </div>
      <div data-pop="" className="space-y-2.5 rounded-2xl rounded-tl-md border border-dashed border-mk-violet/60 bg-white p-4">
        <span className={`${chip} inline-block bg-mk-violet/10 text-mk-violet`}>{ART.copilot.tag}</span>
        {[92, 78, 44].map((w) => (
          <i key={w} data-grow="" className={`${line} bg-mk-rule`} style={{ width: `${w}%` }} />
        ))}
        <i className="mk-caret" />
      </div>
    </div>
  );
}

// 2e. The apps platform: order events leave the store signed, to apps that
// hold a key for only what was approved.
export function ArtApps() {
  return (
    <div aria-hidden="true" data-art="" className="mk-art">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
        <span data-pop="" className="mk-a-sig grid h-14 w-14 place-items-center rounded-2xl text-white">
          <Webhook strokeWidth={1.6} className="h-6 w-6" />
        </span>
        <span className="space-y-5">
          {ART.apps.events.map((e) => (
            <span key={e} className="relative block">
              <svg data-grow="" viewBox="0 0 100 4" preserveAspectRatio="none" className="block h-1 w-full">
                <path d="M0 2H100" className="mk-a-dash" />
              </svg>
              <span data-pop="" className={`${chip} absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 border border-mk-rule bg-white whitespace-nowrap text-mk-navy`}>
                {e}
              </span>
            </span>
          ))}
        </span>
        <span className="space-y-2">
          {three.slice(0, 2).map((i) => (
            <span key={i} data-pop="" className="grid h-11 w-11 place-items-center rounded-xl border border-mk-rule bg-white text-mk-violet">
              <KeyRound strokeWidth={1.6} className="h-4 w-4" />
            </span>
          ))}
        </span>
      </div>
      <span data-pop="" className={`${chip} mt-3 inline-flex items-center gap-1 bg-mk-violet/10 text-mk-violet`}>
        <Lock strokeWidth={2} className="h-3 w-3" />
        {ART.apps.signed}
      </span>
    </div>
  );
}

// 3. One small picture for each thing that sells more. Drawn on the navy
// rail, so the strokes are sky and white.
const stroke = { fill: "none", stroke: "#9cc0ff", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" };
const SELL_ART = {
  // quantity tiers: three stacks, the deepest cut on the tallest
  offers: (
    <>
      {[[14, 46, 26], [58, 34, 38], [102, 18, 54]].map(([x, y, h], i) => (
        <rect key={x} data-pop="" x={x} y={y} width="32" height={h} rx="7" fill={i === 2 ? "url(#mk-g-light)" : "rgb(255 255 255 / 0.14)"} stroke="rgb(255 255 255 / 0.35)" />
      ))}
      <path d="M112 37l12-12m-11 1.5h.01m9.99 9h.01" {...stroke} stroke="#fff" strokeWidth="2" />
    </>
  ),
  // the cart's bar filling towards the gift at its end
  nudges: (
    <>
      <rect x="12" y="40" width="112" height="8" rx="4" fill="rgb(255 255 255 / 0.16)" />
      <rect data-grow="" x="12" y="40" width="78" height="8" rx="4" fill="url(#mk-g-light)" />
      <circle cx="90" cy="44" r="7" fill="#fff" />
      <path d="M130 34h20v20h-20zm-3-7h26v7h-26zm13 0v27m0-27c-8-9-14 0 0 0Zm0 0c8-9 14 0 0 0Z" {...stroke} />
    </>
  ),
  // a month with the offer's days marked
  schedule: (
    <>
      <rect x="20" y="14" width="120" height="60" rx="10" {...stroke} />
      <path d="M20 30h120M48 9v10m64-10v10" {...stroke} />
      <rect data-grow="" x="50" y="40" width="62" height="12" rx="6" fill="url(#mk-g-light)" />
      {[32, 122].map((x) => (
        <circle key={x} cx={x} cy="46" r="3" fill="rgb(255 255 255 / 0.35)" />
      ))}
      {[32, 56, 80, 104].map((x) => (
        <circle key={x} cx={x} cy="63" r="3" fill="rgb(255 255 255 / 0.35)" />
      ))}
    </>
  ),
  // a parcel that comes round again, with pause and skip beside it
  subscribe: (
    <>
      <path data-stroke="" pathLength="1" d="M54 22a30 30 0 1 1-9 34" {...stroke} stroke="url(#mk-g-light)" strokeWidth="3" />
      <path d="M38 50l7 7 8-6" {...stroke} stroke="#fff" />
      <rect x="62" y="33" width="24" height="22" rx="4" fill="rgb(255 255 255 / 0.14)" stroke="#fff" strokeWidth="1.5" />
      <path d="M62 41h24M124 34v20m9-20v20" {...stroke} stroke="#fff" />
    </>
  ),
  // three answers, one chosen, and where it leads
  quiz: (
    <>
      {[14, 38, 62].map((y, i) => (
        <rect key={y} data-pop="" x="12" y={y} width="74" height="16" rx="8" fill={i === 1 ? "url(#mk-g-light)" : "rgb(255 255 255 / 0.12)"} stroke="rgb(255 255 255 / 0.35)" />
      ))}
      <path d="M21 46l3 3 5-6" {...stroke} stroke="#fff" strokeWidth="2" />
      <path data-stroke="" pathLength="1" d="M90 46h20" {...stroke} stroke="#fff" />
      <path d="M106 41l5 5-5 5" {...stroke} stroke="#fff" />
      <rect x="118" y="26" width="32" height="40" rx="8" fill="rgb(255 255 255 / 0.14)" stroke="#9cc0ff" strokeWidth="1.5" />
    </>
  ),
  // marks from a buyer with a tick: the purchase came first
  ratings: (
    <>
      {five.map((i) => (
        <g key={i} transform={`translate(${12 + i * 22} 30)`}>
          <path data-pop="" d="M10 0l3.1 6.3 6.9 1-5 4.9 1.2 6.8L10 15.8 3.8 19 5 12.2 0 7.3l6.9-1Z" fill={i === 4 ? "rgb(255 255 255 / 0.2)" : "#9cc0ff"} />
        </g>
      ))}
      <circle cx="140" cy="40" r="13" fill="#fff" />
      <path d="M134 40l4 4 8-9" {...stroke} stroke="#5b2be0" strokeWidth="2.5" />
    </>
  ),
  // two messages, the second one read
  whatsapp: (
    <>
      <path data-pop="" d="M18 12h84a8 8 0 0 1 8 8v14a8 8 0 0 1-8 8H34l-10 8v-8h-6a8 8 0 0 1-8-8V20a8 8 0 0 1 8-8Z" fill="rgb(255 255 255 / 0.14)" stroke="rgb(255 255 255 / 0.4)" />
      <path data-pop="" d="M60 50h78a8 8 0 0 1 8 8v12a8 8 0 0 1-8 8h-4v7l-9-7H60a8 8 0 0 1-8-8V58a8 8 0 0 1 8-8Z" fill="url(#mk-g-light)" />
      <path d="M22 22h56M22 31h34M64 62h44" {...stroke} stroke="#fff" />
      <path d="M118 65l4 4 7-8m-2 8 7-8" {...stroke} stroke="#fff" />
    </>
  ),
  // the road from the shelf to the door
  delivery: (
    <>
      <path d="M14 66h132" {...stroke} stroke="rgb(255 255 255 / 0.2)" strokeDasharray="2 6" />
      <path data-stroke="" pathLength="1" d="M14 66h92" {...stroke} strokeWidth="3" />
      <path d="M78 44h20l8 9v13H78zm-26-8h26v30H52z" fill="#0b0656" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
      {[62, 96].map((x) => (
        <circle key={x} cx={x} cy="67" r="5" fill="#fff" />
      ))}
      <path d="M140 30a9 9 0 0 0-9 9c0 7 9 16 9 16s9-9 9-16a9 9 0 0 0-9-9Z" {...stroke} stroke="#fff" />
      <circle cx="140" cy="39" r="3" fill="#9cc0ff" />
    </>
  ),
};
export function ArtSell({ id }) {
  return (
    <svg aria-hidden="true" data-art="" viewBox="0 0 160 92" className="mk-a-sell">
      {SELL_ART[id]}
    </svg>
  );
}

// 4a. Checkout on a phone: six digits fill the address, the date shows, and
// paying online sits above cash on delivery.
export function ArtCheckout() {
  const c = ART.checkout;
  return (
    <div aria-hidden="true" data-art="" className="mk-art mk-a-checkout">
      <div data-pop="" className="mk-a-phone">
        <i className="mx-auto mb-4 block h-1.5 w-14 rounded-full bg-mk-rule" />
        <span className="text-[0.6875rem] font-semibold text-mk-muted">{c.pin}</span>
        <span className="mt-1.5 grid grid-cols-6 gap-1.5">
          {[...c.pinValue].map((d, i) => (
            <b key={i} data-pop="" className="grid h-9 place-items-center rounded-lg border border-mk-violet/50 bg-mk-violet/5 text-sm font-semibold tabular-nums text-mk-navy">
              {d}
            </b>
          ))}
        </span>
        <span className="mt-3 flex flex-wrap gap-1.5">
          {[c.city, c.state].map((v) => (
            <span key={v} data-pop="" className={`${chip} inline-flex items-center gap-1 bg-mk-mist text-mk-navy`}>
              <Check strokeWidth={3} className="h-3 w-3 text-mk-violet" />
              {v}
            </span>
          ))}
        </span>
        <span data-pop="" className="mt-3 flex items-center gap-2 rounded-xl bg-mk-mist px-3 py-2.5 text-xs font-medium text-mk-body">
          <Truck strokeWidth={1.7} className="h-4 w-4 text-mk-violet" />
          {c.date}
          <i className={`${line} ml-auto w-10 mk-a-light`} />
        </span>
        <span data-pop="" className="mt-3 flex items-center gap-2.5 rounded-xl border-2 border-mk-violet px-3 py-2.5 text-xs font-semibold text-mk-navy">
          <i className="mk-a-radio" data-on="" />
          {c.online}
          <CreditCard strokeWidth={1.7} className="ml-auto h-4 w-4 text-mk-violet" />
        </span>
        <span data-pop="" className="mt-2 flex items-center gap-2.5 rounded-xl border border-mk-rule px-3 py-2.5 text-xs font-medium text-mk-body">
          <i className="mk-a-radio" />
          {c.cod}
        </span>
        <i data-pop="" className="mk-a-sig mt-4 block h-10 rounded-full" />
      </div>
      <div data-pop="" className="mk-a-side mk-a-side-top max-sm:hidden">
        <span className={`mk-bob ${card} flex items-center gap-2.5 px-3.5 py-3 text-xs font-semibold text-mk-navy`}>
          <Glyph id="address" />
          {c.saved}
        </span>
      </div>
      <div data-pop="" className="mk-a-side mk-a-side-low max-sm:hidden">
        <span className={`mk-bob mk-bob-late ${card} block px-3.5 py-3`}>
          <span className="text-[0.6875rem] font-semibold text-mk-muted">{c.code}</span>
          <span className="mt-2 flex gap-1.5">
            {[0, 1, 2, 3].map((i) => (
              <i key={i} className="block h-2.5 w-2.5 rounded-full bg-mk-violet" />
            ))}
          </span>
        </span>
      </div>
    </div>
  );
}

// 4b. More than one market: a globe with the currencies going round it.
export function ArtGlobe() {
  return (
    <div aria-hidden="true" data-art="" className="mk-a-globe">
      <svg viewBox="0 0 120 120" className="h-full w-full">
        <circle cx="60" cy="60" r="44" fill="rgb(255 255 255 / 0.08)" stroke="#9cc0ff" strokeWidth="1.2" />
        <path data-stroke="" pathLength="1" d="M16 60h88M60 16c-22 22-22 66 0 88m0-88c22 22 22 66 0 88M24 38c22 10 50 10 72 0M24 82c22-10 50-10 72 0" fill="none" stroke="#9cc0ff" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
      {["₹", "$", "€", "£"].map((sign, i) => (
        <b key={sign} data-pop="" className="mk-a-coin" style={{ "--n": i }}>
          {sign}
        </b>
      ))}
    </div>
  );
}

// 6. Control, as a diagram: the catalog is read one way, orders are the only
// thing sent back; a change goes draft, preview, publish, and can be undone;
// four roles, each with less reach than the one before.
export function ArtControl() {
  const c = ART.control;
  const box = "rounded-2xl border px-4 py-4 text-sm font-semibold sm:px-5";
  return (
    <div aria-hidden="true" data-art="" className="mk-art mk-a-control">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(4.5rem,0.8fr)_minmax(0,1fr)] items-center">
        <span data-pop="" className={`${box} border-mk-rule bg-white text-mk-navy`}>
          <Database strokeWidth={1.6} className="mb-2 h-5 w-5 text-mk-violet" />
          {c.shopify}
        </span>
        <span className="relative grid gap-3 px-1.5">
          <svg data-grow="" viewBox="0 0 100 12" preserveAspectRatio="none" className="block h-3 w-full">
            <path d="M0 6H96" fill="none" stroke="#5b2be0" strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
          <span data-pop="" className={`${chip} mx-auto inline-flex items-center gap-1 bg-mk-violet/10 whitespace-nowrap text-mk-violet`}>
            <Lock strokeWidth={2.2} className="h-3 w-3" />
            {c.readOnly}
          </span>
          <svg data-grow="end" viewBox="0 0 100 12" preserveAspectRatio="none" className="block h-3 w-full">
            <path d="M100 6H4" className="mk-a-dash" />
          </svg>
          <span data-pop="" className="text-center text-[0.6875rem] font-semibold text-mk-muted">
            {c.orders}
          </span>
        </span>
        <span data-pop="" className={`${box} mk-a-sig border-transparent text-white`}>
          <LayoutTemplate strokeWidth={1.6} className="mb-2 h-5 w-5 text-mk-sky" />
          {c.store}
        </span>
      </div>
      <ol className="mt-8 grid grid-cols-3 gap-2 sm:gap-4">
        {c.steps.map((s, i) => (
          <li key={s} data-pop="" className={`relative rounded-full py-2.5 text-center text-xs font-semibold sm:text-sm ${i === 2 ? "mk-a-sig text-white" : "border border-mk-rule bg-white text-mk-navy"}`}>
            {s}
          </li>
        ))}
      </ol>
      <span data-pop="" className="mt-2 flex items-center justify-end gap-1.5 text-[0.6875rem] font-semibold text-mk-violet">
        <svg viewBox="0 0 64 22" className="h-5 w-16">
          <path data-stroke="" pathLength="1" d="M60 2v6a8 8 0 0 1-8 8H6m6-5-6 5 6 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {c.undo}
      </span>
      <ul className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {c.roles.map((r, i) => (
          <li key={r} data-pop="" className="rounded-xl border border-mk-rule bg-white px-3 py-2.5">
            <span className="text-xs font-semibold text-mk-navy">{r}</span>
            <span className="mt-2 flex gap-1">
              {[0, 1, 2, 3].map((n) => (
                <i key={n} className={`${line} flex-1 ${n + i < 4 ? "mk-a-light" : "bg-mk-rule"}`} />
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// 7. The app stack: twelve rented tiles, drawn together into one.
export function ArtStack({ caption }) {
  return (
    <figure data-art="" className="mk-art mk-a-stack">
      <div aria-hidden="true" className="grid grid-cols-4 gap-2.5 sm:gap-3">
        {STACK.map((row) => (
          <span key={row.id} data-pop="" className="mk-a-tile">
            <Glyph id={row.id} className="mk-glyph-bare" />
          </span>
        ))}
      </div>
      <svg aria-hidden="true" data-grow="" viewBox="0 0 100 100" preserveAspectRatio="none" className="mk-a-wires">
        {[12, 50, 88].map((y) => (
          <path key={y} d={`M0 ${y}C50 ${y} 50 50 100 50`} fill="none" stroke="#5b2be0" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div aria-hidden="true" data-pop="" className="mk-a-one mk-a-sig">
        <span className="mk-pulse" />
        <span className="mk-display relative text-2xl text-white sm:text-3xl">{ART.stack}</span>
      </div>
      <figcaption className="mk-a-cap">{caption}</figcaption>
    </figure>
  );
}

// 8. A plan's size, as bars: one more lit for each tier up.
export function TierBars({ level, ink = false }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 44 32" className="h-8 w-11">
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={i * 11 + 1} y={24 - i * 7} width="8" height={8 + i * 7} rx="2.5" fill={i < level ? (ink ? "#9cc0ff" : "url(#mk-g-light)") : ink ? "rgb(255 255 255 / 0.2)" : "#e1e1f0"} />
      ))}
    </svg>
  );
}

// 9. The closing picture: a shopfront with its awning, open.
export function ArtShop() {
  return (
    <div aria-hidden="true" data-art="" className="mk-art mk-a-shop">
      <span className="mk-a-ring" />
      <span className="mk-a-ring mk-a-ring-wide" />
      <svg viewBox="0 0 240 220" className="relative h-full w-full">
        <rect data-pop="" x="38" y="84" width="164" height="118" rx="12" fill="#fff" stroke="#e1e1f0" strokeWidth="2" />
        <g data-pop="">
          <path d="M26 46h188l14 40a18 18 0 0 1-36 0 18 18 0 0 1-36 0 18 18 0 0 1-36 0 18 18 0 0 1-36 0 18 18 0 0 1-36 0 18 18 0 0 1-36 0Z" fill="url(#mk-g-sig)" />
          <path d="M84 46l-8 40m50-40v40m34-40 8 40" fill="none" stroke="rgb(255 255 255 / 0.35)" strokeWidth="2" />
        </g>
        <rect data-pop="" x="56" y="122" width="62" height="50" rx="8" fill="#f6f6fc" stroke="#e1e1f0" strokeWidth="2" />
        <rect data-pop="" x="136" y="122" width="48" height="80" rx="8" fill="url(#mk-g-light)" />
        <circle cx="146" cy="164" r="3" fill="#fff" />
        <path data-stroke="" pathLength="1" d="M66 160l14-16 12 10 16-20" fill="none" stroke="#5b2be0" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M20 202h200" stroke="#0b0656" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </div>
  );
}
