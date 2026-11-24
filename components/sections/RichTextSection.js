import { settingsOf } from "./parts";

// Rich text (registry kind "rich_text"; a page's old "rich"). The html is
// allowlist-sanitized at save and again at publish (lib/registry/text.js),
// so it is rendered as stored.
// On the home page and on content pages it keeps each page's old markup.
function RichTextSection({ section, ctx = {}, attrs = {} }) {
  const s = settingsOf(section);
  if (ctx.surface === "page") {
    return (
      <section {...attrs}>
        {s.title ? <h2 className="text-lg font-bold text-sf-text">{s.title}</h2> : null}
        <div className="rte mt-2 text-sf-text-muted" dangerouslySetInnerHTML={{ __html: s.html || "" }} />
      </section>
    );
  }
  return (
    <section data-sec={ctx.secKey} {...attrs} className="py-sf-section">
      {s.title ? <h2 className="mb-4 text-2xl font-bold tracking-tight">{s.title}</h2> : null}
      <div className="rte max-w-3xl" dangerouslySetInnerHTML={{ __html: s.html || "" }} />
    </section>
  );
}

export default RichTextSection;
