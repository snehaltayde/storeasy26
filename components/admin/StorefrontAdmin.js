"use client";

import { useState } from "react";

// Storefront CMS console (Session 23): announcement bar, hero, home section
// layout, header/footer nav, content pages. Every save is live on the next
// page render — no deploy. Nav items are typed one per line as "Label | /path".

const input =
  "mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400";

const Field = ({ label, hint, children }) => (
  <label className="block">
    <span className="text-xs font-semibold text-zinc-600">{label}</span>
    {children}
    {hint && <span className="mt-0.5 block text-[11px] text-zinc-400">{hint}</span>}
  </label>
);

const Section = ({ title, desc, customized, onReset, onSave, busy, children }) => (
  <section className="rounded-2xl border border-zinc-200 p-5">
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-sm font-bold">
          {title}
          {customized && <span className="ml-2 rounded bg-lime-100 px-1.5 py-0.5 text-[10px] font-bold text-lime-700">CUSTOMIZED</span>}
        </h2>
        {desc && <p className="mt-0.5 text-xs text-zinc-500">{desc}</p>}
      </div>
      <div className="flex shrink-0 gap-2">
        {customized && onReset && (
          <button type="button" onClick={onReset} disabled={busy} className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-50 disabled:opacity-50">
            Reset to default
          </button>
        )}
        <button type="button" onClick={onSave} disabled={busy} className="rounded-lg bg-zinc-900 px-3 py-1 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50">
          Save
        </button>
      </div>
    </div>
    <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
  </section>
);

const navToText = (nav) => (Array.isArray(nav) ? nav.map((i) => `${i.label} | ${i.href}`).join("\n") : "");
const textToNav = (text) => {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null; // empty = back to catalog-derived
  return lines.map((l) => {
    const [label, href] = l.split("|").map((s) => s.trim());
    return { label: label || "", href: href || "" };
  });
};
const bodyToText = (body) => (body || []).join("\n\n");
const textToBody = (text) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);

function PageEditor({ page, onSave, onCancel, busy }) {
  const [p, setP] = useState({
    slug: page.slug || "",
    title: page.title || "",
    description: page.description || "",
    enabled: page.enabled !== false,
    sections: (page.sections || []).map((s) => ({ heading: s.heading, text: bodyToText(s.body) })),
  });
  const isNew = !page.slug;
  const sec = (i, patch) => setP((prev) => ({ ...prev, sections: prev.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  return (
    <section className="rounded-2xl border border-lime-300 p-5">
      <h2 className="text-sm font-bold">{isNew ? "New page" : `Edit page: ${p.slug}`}</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Slug" hint={isNew ? "lowercase-with-hyphens; served at /policies/<slug>" : "fixed"}>
          <input className={input} value={p.slug} disabled={!isNew} onChange={(e) => setP({ ...p, slug: e.target.value })} />
        </Field>
        <Field label="Title">
          <input className={input} value={p.title} onChange={(e) => setP({ ...p, title: e.target.value })} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Meta description">
            <input className={input} value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} />
          </Field>
        </div>
        {p.sections.map((s, i) => (
          <div key={i} className="sm:col-span-2 rounded-xl border border-zinc-100 p-3">
            <div className="flex items-center gap-2">
              <input className={input + " mt-0"} placeholder="Section heading" value={s.heading} onChange={(e) => sec(i, { heading: e.target.value })} />
              <button type="button" onClick={() => setP((prev) => ({ ...prev, sections: prev.sections.filter((_, j) => j !== i) }))} className="text-zinc-400 hover:text-red-600">
                ✕
              </button>
            </div>
            <textarea
              className={input + " min-h-24 font-normal"}
              placeholder="Paragraphs — separate with a blank line"
              value={s.text}
              onChange={(e) => sec(i, { text: e.target.value })}
            />
          </div>
        ))}
        <div className="sm:col-span-2 flex items-center justify-between">
          <button type="button" onClick={() => setP((prev) => ({ ...prev, sections: [...prev.sections, { heading: "", text: "" }] }))} className="text-sm font-medium text-lime-700 hover:underline">
            + Add section
          </button>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={p.enabled} onChange={(e) => setP({ ...p, enabled: e.target.checked })} />
            Visible
          </label>
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onSave({
              slug: p.slug.trim(),
              title: p.title,
              description: p.description,
              enabled: p.enabled,
              sections: p.sections.map((s) => ({ heading: s.heading, body: textToBody(s.text) })).filter((s) => s.heading),
            })
          }
          className="rounded-xl bg-lime-400 px-4 py-2 text-sm font-bold text-zinc-950 hover:bg-lime-300 disabled:opacity-50"
        >
          Save page
        </button>
        <button type="button" onClick={onCancel} className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-50">
          Cancel
        </button>
      </div>
    </section>
  );
}

export default function StorefrontAdmin({ initial }) {
  const [data, setData] = useState(initial);
  const [ann, setAnn] = useState(initial.blocks.announcement);
  const [hero, setHero] = useState(initial.blocks.hero);
  const [sections, setSections] = useState(initial.blocks.home_sections);
  const [navHeader, setNavHeader] = useState(navToText(initial.blocks.nav_header));
  const [navFooter, setNavFooter] = useState(navToText(initial.blocks.nav_footer));
  const [editingPage, setEditingPage] = useState(null); // page object | null
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  // S35: after a 409, remember WHAT conflicted so a deliberate re-save of that
  // same thing overwrites (sends no revision) instead of looping on 409.
  const [conflict, setConflict] = useState(null);

  async function put(body) {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/admin/storefront", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
      if (json.blocks) {
        setData(json);
        setAnn(json.blocks.announcement);
        setHero(json.blocks.hero);
        setSections(json.blocks.home_sections);
        setNavHeader(navToText(json.blocks.nav_header));
        setNavFooter(navToText(json.blocks.nav_footer));
      }
      setMsg({ ok: true, text: ["Saved — live on the next page load."] });
    } else if (res.status === 409) {
      // S35: someone else saved since this editor loaded. Their version is on
      // the server, yours stays in the form — reload to see theirs, or save
      // again to overwrite deliberately.
      setMsg({
        ok: false,
        text: [
          "Save blocked: this was edited by someone else since you loaded it.",
          "Your changes are still in the form. Reload the page to see their version first, or press Save again to overwrite it.",
        ],
      });
      setConflict(body); // next save of the same body skips the stale check
    } else {
      setMsg({ ok: false, text: json.errors || [json.error || `Save failed (${res.status})`] });
    }
    setBusy(false);
    return json;
  }

  async function openPage(slug) {
    setBusy(true);
    const res = await fetch("/api/admin/storefront", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ getPage: slug }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (json.page) setEditingPage(json.page);
  }

  // Saves carry the revision loaded with the current view (CAS). After a 409
  // on the same target, the retry omits the revision = deliberate overwrite.
  const saveBlock = (block, value) => {
    const overwrite = conflict?.block === block;
    if (overwrite) setConflict(null);
    return put({ block, value, ...(overwrite ? {} : { revision: data.revisions?.[block] ?? null }) });
  };
  const savePage = (page) => {
    const overwrite = conflict?.page?.slug === page.slug;
    if (overwrite) setConflict(null);
    return put({ page, ...(overwrite ? {} : { revision: data.pageRevisions?.[page.slug] ?? null }) });
  };
  const resetBlock = (block) => put({ block, reset: true });
  const swapSections = () => setSections((s) => [...s].reverse());

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-4 sm:px-6">
      <div>
        <h1 className="text-2xl font-bold">Storefront</h1>
        <p className="text-sm text-zinc-500">Merchandising — announcement, hero, home layout, navigation, pages.</p>
      </div>

      {msg && (
        <div className={`rounded-xl px-4 py-3 text-sm ${msg.ok ? "bg-lime-50 text-lime-700" : "bg-red-50 text-red-600"}`}>
          {msg.text.map((t, i) => (
            <p key={i}>{t}</p>
          ))}
        </div>
      )}

      {editingPage ? (
        <PageEditor
          page={editingPage}
          busy={busy}
          onCancel={() => setEditingPage(null)}
          onSave={async (page) => {
            const json = await savePage(page);
            if (json.ok) setEditingPage(null);
          }}
        />
      ) : (
        <>
          <Section title="Announcement bar" desc="Thin strip above the header." customized={data.customized.announcement} busy={busy} onSave={() => saveBlock("announcement", ann)} onReset={() => resetBlock("announcement")}>
            <Field label="Text">
              <input className={input} value={ann.text} onChange={(e) => setAnn({ ...ann, text: e.target.value })} />
            </Field>
            <Field label="Link" hint="optional — /collections/sale or a full URL">
              <input className={input} value={ann.href} onChange={(e) => setAnn({ ...ann, href: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!ann.enabled} onChange={(e) => setAnn({ ...ann, enabled: e.target.checked })} />
              Show the bar
            </label>
          </Section>

          <Section title="Hero" desc="The big home-page opener." customized={data.customized.hero} busy={busy} onSave={() => saveBlock("hero", hero)} onReset={() => resetBlock("hero")}>
            <Field label="Title">
              <input className={input} value={hero.title} onChange={(e) => setHero({ ...hero, title: e.target.value })} />
            </Field>
            <Field label="Highlight" hint="substring of the title shown in the accent color">
              <input className={input} value={hero.highlight || ""} onChange={(e) => setHero({ ...hero, highlight: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Subtitle">
                <input className={input} value={hero.subtitle || ""} onChange={(e) => setHero({ ...hero, subtitle: e.target.value })} />
              </Field>
            </div>
            <Field label="Badge" hint="blank = live catalog stats">
              <input className={input} value={hero.badge || ""} onChange={(e) => setHero({ ...hero, badge: e.target.value })} />
            </Field>
            <div />
            <Field label="Primary CTA label">
              <input className={input} value={hero.primary?.label || ""} onChange={(e) => setHero({ ...hero, primary: { ...hero.primary, label: e.target.value } })} />
            </Field>
            <Field label="Primary CTA link">
              <input className={input} value={hero.primary?.href || ""} onChange={(e) => setHero({ ...hero, primary: { ...hero.primary, href: e.target.value } })} />
            </Field>
            <Field label="Secondary CTA label">
              <input className={input} value={hero.secondary?.label || ""} onChange={(e) => setHero({ ...hero, secondary: { ...hero.secondary, label: e.target.value } })} />
            </Field>
            <Field label="Secondary CTA link">
              <input className={input} value={hero.secondary?.href || ""} onChange={(e) => setHero({ ...hero, secondary: { ...hero.secondary, href: e.target.value } })} />
            </Field>
          </Section>

          <Section title="Home sections" desc="Order, titles and sizes of the home-page sections." customized={data.customized.home_sections} busy={busy} onSave={() => saveBlock("home_sections", sections)} onReset={() => resetBlock("home_sections")}>
            {sections.map((s, i) => (
              <div key={s.kind} className="rounded-xl border border-zinc-100 p-3">
                <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">
                  {i + 1}. {s.kind === "collections" ? "Collections grid" : "Newest products"}
                </p>
                <input className={input} value={s.title} onChange={(e) => setSections(sections.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                <div className="mt-2 flex items-center gap-3 text-sm">
                  <label className="flex items-center gap-1.5">
                    Show
                    <input type="checkbox" checked={s.enabled !== false} onChange={(e) => setSections(sections.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))} />
                  </label>
                  <label className="flex items-center gap-1.5">
                    Items
                    <input className="w-16 rounded-lg border border-zinc-200 px-2 py-1" value={s.limit} onChange={(e) => setSections(sections.map((x, j) => (j === i ? { ...x, limit: e.target.value } : x)))} />
                  </label>
                </div>
              </div>
            ))}
            <button type="button" onClick={swapSections} className="justify-self-start text-sm font-medium text-lime-700 hover:underline">
              ⇅ Swap order
            </button>
          </Section>

          <Section title="Header navigation" desc='One per line: "Label | /path". Empty = all collections (automatic).' customized={data.customized.nav_header} busy={busy} onSave={() => saveBlock("nav_header", textToNav(navHeader))} onReset={() => resetBlock("nav_header")}>
            <div className="sm:col-span-2">
              <textarea className={input + " min-h-24 font-mono text-xs"} value={navHeader} onChange={(e) => setNavHeader(e.target.value)} placeholder={"Proteins | /collections/protein\nSale | /collections/sale"} />
            </div>
          </Section>

          <Section title="Footer shop links" desc='One per line: "Label | /path". Empty = top 5 collections (automatic).' customized={data.customized.nav_footer} busy={busy} onSave={() => saveBlock("nav_footer", textToNav(navFooter))} onReset={() => resetBlock("nav_footer")}>
            <div className="sm:col-span-2">
              <textarea className={input + " min-h-24 font-mono text-xs"} value={navFooter} onChange={(e) => setNavFooter(e.target.value)} />
            </div>
          </Section>

          <section className="rounded-2xl border border-zinc-200 p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold">Content pages</h2>
                <p className="mt-0.5 text-xs text-zinc-500">About, contact and policies — defaults until you customize them.</p>
              </div>
              <button type="button" onClick={() => setEditingPage({ sections: [] })} className="rounded-lg bg-zinc-900 px-3 py-1 text-xs font-semibold text-white hover:bg-zinc-800">
                + New page
              </button>
            </div>
            <ul className="mt-3 divide-y divide-zinc-100">
              {data.pages.map((p) => (
                <li key={p.slug} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{p.title}</span>
                    <span className="ml-2 font-mono text-xs text-zinc-400">/{p.slug === "about" || p.slug === "contact" ? p.slug : `policies/${p.slug}`}</span>
                    <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold ${p.source === "custom" ? "bg-lime-100 text-lime-700" : "bg-zinc-100 text-zinc-500"}`}>
                      {p.source === "custom" ? "CUSTOMIZED" : "DEFAULT"}
                    </span>
                    {!p.enabled && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">HIDDEN</span>}
                  </span>
                  <button type="button" onClick={() => openPage(p.slug)} className="font-medium text-lime-700 hover:underline">
                    Edit
                  </button>
                  {p.source === "custom" && (
                    <button type="button" onClick={() => window.confirm(`Remove the customized "${p.slug}" page? Default content (if any) returns.`) && put({ deletePage: p.slug })} className="text-zinc-400 hover:text-red-600">
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
