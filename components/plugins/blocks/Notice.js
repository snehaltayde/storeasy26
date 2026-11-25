// Phase 4 line 2: the notice primitive. A server component: no client code,
// no event handlers, no raw HTML. title, text and link_label are plain words
// (React escapes them); link passed isStorefrontHref, so it is a path on this
// store, never another site or a javascript: address.
import Link from "next/link";

export default function Notice({ title, text, link_label: linkLabel, link }) {
  if (!text) return null;
  return (
    <div className="rounded-sf-card border border-sf-border-soft bg-sf-surface-muted p-4 text-sm">
      {title ? <p className="font-semibold text-sf-text">{title}</p> : null}
      <p className={`${title ? "mt-1 " : ""}text-sf-text-muted`}>{text}</p>
      {link && linkLabel ? (
        <Link href={link} className="mt-2 inline-block font-semibold text-sf-accent-text underline">
          {linkLabel}
        </Link>
      ) : null}
    </div>
  );
}
