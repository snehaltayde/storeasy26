import Link from "next/link";
import StoreImage from "@/components/StoreImage";
import ExperimentNote from "@/components/preview/ExperimentNote";
import { DEFAULT_HERO_SUBTITLE, EMPTY_STORE_HERO_SUBTITLE } from "@/lib/cms/defaults";
import { settingsToLegacyHero } from "@/lib/registry/legacy";
import { isOptimizable } from "@/lib/image-src";

// The hero section (P2-SECTIONS, DOC-07). Moved out of app/(storefront)/page.js
// with the same markup, so a store's hero looks exactly as before. It reads a
// registry hero section ({ id, kind: "hero", settings }); the settings are
// turned back into the flat hero the old page used (typed button links become
// hrefs), so every rule below is the page's old rule, word for word.
//
// New: an optional image (settings.image = { media, alt }). It goes through
// StoreImage, so a library photo (/api/media/<id>) is served as its own url
// (P1-IMAGES). The registry accepts any https photo or "/" path here, and
// Next's optimizer can fetch only the Shopify CDN (next.config.mjs), so every
// other image goes out unoptimized, as its own url: never a broken image
// (DOC-03). With no image the markup is the old hero's, byte for byte.
//
// ctx (from the home page): { empty, stats, notice }
//   empty   the store has no products yet (GEN-03 words)
//   stats   { products, collections } for the default badge
//   notice  PV-08's "a test is running" note, preview only
//
// P3-FRAME (ED-04): in a documents preview (ctx.preview true) the words carry
// data-field with validate's field paths (title, subtitle, primary.label,
// secondary.label, badge), so a click in the editor's frame picks that field.
// The section is picked by its data-section-id; the old data-sec="hero" (the
// legacy Designer's target) stays. Live markup is unchanged.
//
// A hero button linked to a sold-out product (DOC-03 state table): the hero
// stays as it is and the button still opens the product page, which says the
// product is sold out. Nothing here looks at stock.

// Wrap the hero title's highlight substring in the accent color.
function HeroTitle({ title, highlight }) {
  const i = highlight ? title.toLowerCase().indexOf(highlight.toLowerCase()) : -1;
  if (i < 0) return <>{title}</>;
  return (
    <>
      {title.slice(0, i)}
      <span className="text-sf-hero-accent">{title.slice(i, i + highlight.length)}</span>
      {title.slice(i + highlight.length)}
    </>
  );
}

// The image a hero shows, or null. A media value that isn't a non-empty
// string (missing, "", or a bad shape) is no image: the hero renders as before.
export function heroImageOf(settings) {
  const image = settings?.image;
  if (!image || typeof image !== "object" || typeof image.media !== "string" || !image.media.trim()) return null;
  return { media: image.media, alt: typeof image.alt === "string" ? image.alt : "" };
}

// The badge's words: a bare text node live (as before); in a preview, the
// founder's own badge sits in a span carrying its field.
const BadgeWords = ({ field, words }) => (field["data-field"] ? <span {...field}>{words}</span> : <>{words}</>);

const text = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

function HeroSection({ section, ctx = {}, attrs = {} }) {
  const hero = settingsToLegacyHero(section?.settings);
  // P2-PREVIEW: an unfinished hero in a preview shows its hint where the title goes
  if (section?.unfinished && !text(hero.title).trim()) hero.title = section.unfinished.placeholder;
  const title = text(hero.title);
  const highlight = typeof hero.highlight === "string" ? hero.highlight : "";
  const empty = Boolean(ctx.empty);
  const stats = ctx.stats || { products: 0, collections: 0 };
  // GEN-03: on an empty store the default words promise a catalog, and #new only
  // exists inside HomeSections. A founder's own subtitle stays as written.
  const subtitle = empty && hero.subtitle === DEFAULT_HERO_SUBTITLE ? EMPTY_STORE_HERO_SUBTITLE : hero.subtitle;
  const showSecondary = hero.secondary?.label && !(empty && (hero.secondary.href || "#new") === "#new");
  const image = heroImageOf(section?.settings);
  const field = (path) => (ctx.preview === true ? { "data-field": path } : {});

  const words = (
    <>
      <ExperimentNote notice={ctx.notice || null} />
      <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-hero-fg/15 px-3 py-1 text-xs font-medium text-sf-hero-accent">
        <span className="h-1.5 w-1.5 rounded-full bg-sf-hero-accent" />
        <BadgeWords field={!empty && hero.badge ? field("badge") : {}} words={empty ? "Coming soon" : hero.badge || `${stats.products} products · ${stats.collections} collections`} />
      </p>
      <h1 {...field("title")} className="max-w-3xl font-display text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
        <HeroTitle title={title} highlight={highlight} />
      </h1>
      {subtitle ? (
        <p {...field("subtitle")} className="mt-5 max-w-xl text-lg text-hero-muted">
          {subtitle}
        </p>
      ) : null}
      <div className="mt-8 flex flex-wrap gap-3">
        {hero.primary?.label ? (
          <Link
            {...field("primary.label")}
            href={hero.primary.href || "/collections"}
            className="rounded-sf-button bg-sf-accent px-6 py-3 text-sm font-bold text-sf-on-accent transition hover:bg-sf-accent-hover"
          >
            {hero.primary.label}
          </Link>
        ) : null}
        {showSecondary ? (
          <Link
            {...field("secondary.label")}
            href={hero.secondary.href || "#new"}
            className="rounded-sf-button border border-hero-fg/20 px-6 py-3 text-sm font-semibold text-hero-fg transition hover:bg-hero-fg/10"
          >
            {hero.secondary.label}
          </Link>
        ) : null}
      </div>
    </>
  );

  return (
    <section data-sec="hero" {...attrs} className="relative overflow-hidden bg-hero text-hero-fg">
      <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-sf-hero-glow/20 blur-3xl" />
      <div className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
        {image ? (
          <div className="grid items-center gap-10 md:grid-cols-2">
            <div>{words}</div>
            <div data-hero-image="" className="relative aspect-[4/3] overflow-hidden rounded-sf-card bg-gradient-to-br from-sf-media-from to-sf-media-to">
              <StoreImage src={image.media} alt={image.alt} unoptimized={!isOptimizable(image.media)} fill priority sizes="(min-width:768px) 50vw, 100vw" className="object-cover" />
            </div>
          </div>
        ) : (
          words
        )}
      </div>
    </section>
  );
}

export default HeroSection;
