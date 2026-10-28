"use client";

import { useState } from "react";

// Theme library (S37 / MC07): kit cards with swatches + type sample; applying
// pins the kit and seeds its brand defaults (and hero preset) as DRAFTS.
export default function ThemeAdmin({ initial }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function apply(kit) {
    if (
      !confirm(
        `Apply the ${kit.label} kit?\n\nThis pins your store to ${kit.label} v${kit.version} and replaces your DRAFT brand tokens (and hero copy) with the kit's defaults. Nothing goes live until you publish a release.`,
      )
    )
      return;
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/admin/theme", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "apply", kit: kit.id }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok && json.ok) {
      setData(json);
      setMsg({ ok: true, text: `${kit.label} applied as a draft — review in Brand/Storefront, preview it, then publish from the Releases tab.` });
    } else {
      setMsg({ ok: false, text: json.error || `Apply failed (${res.status})` });
    }
  }

  const current = data.theme?.kit || "pulse";

  return (
    <div className="space-y-5">
      {msg && <div className={`rounded-xl px-4 py-3 text-sm ${msg.ok ? "bg-lime-50 text-lime-700" : "bg-red-50 text-red-600"}`}>{msg.text}</div>}
      <div className="grid gap-5 sm:grid-cols-2">
        {data.kits.map((kit) => (
          <section key={kit.id} className="overflow-hidden rounded-2xl border border-zinc-200">
            {/* mini preview: header band + hero sample in the kit's own surfaces */}
            <div style={{ background: kit.id === "glow" ? "#fff1ee" : "#09090b", color: kit.id === "glow" ? "#1c1917" : "#fff" }} className="px-5 py-6">
              <p className="text-[10px] font-bold uppercase tracking-widest opacity-60">{kit.vertical}</p>
              <p style={{ fontFamily: kit.fonts.display === "serif" ? "Georgia, serif" : "inherit" }} className="mt-1 text-2xl font-extrabold">
                {kit.label} looks like this.
              </p>
              <span style={{ background: kit.brand.accent, color: kit.id === "glow" ? "#fff" : "#0a0a0b" }} className="mt-3 inline-block rounded-full px-4 py-1.5 text-xs font-bold">
                Shop now
              </span>
            </div>
            <div className="p-5">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold">
                  {kit.label} <span className="font-normal text-zinc-400">v{kit.version}</span>
                </h2>
                {current === kit.id && <span className="rounded-full bg-lime-100 px-2 py-0.5 text-[10px] font-bold text-lime-700">CURRENT</span>}
                <span className="ml-auto flex gap-1">
                  {kit.swatch.map((c) => (
                    <span key={c} className="h-4 w-4 rounded-full border border-zinc-200" style={{ background: c }} />
                  ))}
                </span>
              </div>
              <p className="mt-2 text-sm text-zinc-500">{kit.description}</p>
              <button
                onClick={() => apply(kit)}
                disabled={busy || (current === kit.id && data.theme?.version === kit.version)}
                className="mt-4 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-bold text-white transition hover:bg-zinc-700 disabled:opacity-40"
              >
                {current === kit.id && data.theme?.version === kit.version ? "Applied" : busy ? "Applying…" : `Apply ${kit.label}`}
              </button>
            </div>
          </section>
        ))}
      </div>
      <p className="text-xs text-zinc-400">
        Applying a kit is a DRAFT change: it pins the kit version, resets your draft brand tokens to the kit's defaults and
        replaces the draft hero copy with its preset. Your live storefront only changes when you publish a release — and
        rollback always works. Kit versions never upgrade silently.
      </p>
    </div>
  );
}
