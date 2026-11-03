import Link from "next/link";
import { buttonOf, settingsOf } from "./parts";

// A banner (registry kind "banner"). Same markup as the old HomeSections
// branch; the button is a typed link now ({ label, link }).
function BannerSection({ section, ctx = {}, attrs = {} }) {
  const s = settingsOf(section);
  const button = buttonOf(s.button);
  return (
    <section data-sec={ctx.secKey} {...attrs} className="py-sf-section">
      <div className="rounded-brand bg-sf-accent-soft px-6 py-10 text-center sm:px-10">
        {s.title ? <h2 className="font-display text-2xl font-bold tracking-tight text-sf-on-accent-soft-strong">{s.title}</h2> : null}
        {s.text ? <p className="mx-auto mt-2 max-w-xl text-sf-on-accent-soft">{s.text}</p> : null}
        {button.href && button.label ? (
          <Link href={button.href} className="mt-5 inline-block rounded-sf-button bg-sf-accent px-6 py-3 text-sm font-bold text-sf-on-accent transition hover:bg-sf-accent-hover">
            {button.label}
          </Link>
        ) : null}
      </div>
    </section>
  );
}

export default BannerSection;
