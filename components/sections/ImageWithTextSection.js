import Link from "next/link";
import { MediaFallback, altOf, buttonOf, imageOf, settingsOf } from "./parts";

// Image with text (registry kind "image_with_text"; a page's old "image").
// Home page: the old two-column layout. Content page: the old figure with its
// caption. Plain <img>: library photos are same-origin and any https photo is
// allowed, as before.
// DOC-03 state table: with no image, the brand gradient shows where the photo
// goes (never a broken image), and the words still show.
function ImageWithTextSection({ section, ctx = {}, attrs = {} }) {
  const s = settingsOf(section);
  const image = imageOf(s.image);
  if (ctx.surface === "page") {
    return (
      <figure {...attrs}>
        {/* library images are same-origin, arbitrary https allowed too — plain <img>, not next/image */}
        {image ? <img src={image.src} alt={image.alt} className="w-full rounded-brand" loading="lazy" /> : <MediaFallback alt={altOf(s.image)} className="aspect-[4/3] w-full rounded-brand" />}
        {s.caption ? <figcaption className="mt-2 text-center text-sm text-sf-text-faint">{s.caption}</figcaption> : null}
      </figure>
    );
  }
  const right = s.image_side === "right";
  const button = buttonOf(s.button);
  return (
    <section data-sec={ctx.secKey} {...attrs} data-part="section" className="py-sf-section">
      <div className="grid items-center gap-8 md:grid-cols-2">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image.src} alt={image.alt} loading="lazy" className={`w-full rounded-brand object-cover ${right ? "md:order-2" : ""}`} />
        ) : (
          <MediaFallback alt={altOf(s.image)} className={`aspect-[4/3] w-full rounded-brand ${right ? "md:order-2" : ""}`} />
        )}
        <div className={right ? "md:order-1" : ""}>
          {s.title ? <h2 data-part="section-heading" className="font-display text-2xl font-bold tracking-tight sm:text-3xl">{s.title}</h2> : null}
          {s.text ? <p className="mt-3 max-w-prose text-base text-foreground/75">{s.text}</p> : null}
          {button.href && button.label ? (
            <Link
              href={button.href}
              className="mt-6 inline-block rounded-sf-button bg-sf-accent px-6 py-3 text-sm font-bold text-sf-on-accent transition hover:bg-sf-accent-hover"
            >
              {button.label}
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export default ImageWithTextSection;
