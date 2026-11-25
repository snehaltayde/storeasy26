import { settingsOf } from "./parts";

// Text: a title and paragraphs (registry kind "text"; a page's old default
// section). On content pages it keeps the old markup; on the home page it uses
// the home page's spacing and heading size.
function TextSection({ section, ctx = {}, attrs = {} }) {
  const s = settingsOf(section);
  const body = Array.isArray(s.body) ? s.body : [];
  if (ctx.surface === "page") {
    return (
      <section {...attrs}>
        {s.title ? <h2 className="text-lg font-bold text-sf-text">{s.title}</h2> : null}
        <div className="mt-2 space-y-3">
          {body.map((p, i) => (
            <p key={i} className="leading-relaxed text-sf-text-muted">
              {p}
            </p>
          ))}
        </div>
      </section>
    );
  }
  return (
    <section data-sec={ctx.secKey} {...attrs} data-part="section" className="py-sf-section">
      {s.title ? <h2 data-part="section-heading" className="mb-4 text-2xl font-bold tracking-tight">{s.title}</h2> : null}
      <div className="max-w-3xl space-y-3">
        {body.map((p, i) => (
          <p key={i} className="leading-relaxed text-sf-text-muted">
            {p}
          </p>
        ))}
      </div>
    </section>
  );
}

export default TextSection;
