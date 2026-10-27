"use client";

import { useState } from "react";

// Brand tokens editor (S35 / MC10). Colors + radius + type scale; live shade
// ladder preview; WCAG contrast errors BLOCK save (server re-validates),
// warnings show but don't block. Reset returns to the platform default look.
const RADII = ["sm", "md", "lg", "xl"];
const SCALES = ["compact", "regular", "large"];

function ColorField({ label, value, onChange, hint }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</span>
      <span className="mt-1 flex items-center gap-2">
        <input
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-12 cursor-pointer rounded border border-zinc-200"
          aria-label={`${label} color picker`}
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder="#84cc16"
          className="w-28 rounded-lg border border-zinc-200 px-2 py-1.5 font-mono text-sm"
        />
      </span>
      {hint && <span className="mt-1 block text-xs text-zinc-400">{hint}</span>}
    </label>
  );
}

export default function BrandAdmin({ initial }) {
  const [brand, setBrand] = useState(initial.brand);
  const [customized, setCustomized] = useState(initial.customized);
  const [shades, setShades] = useState(initial.shades);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const set = (key) => (value) => setBrand((b) => ({ ...b, [key]: value }));

  async function call(body) {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/admin/brand", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok && json.ok) {
      setBrand(json.brand);
      setCustomized(json.customized);
      setShades(json.shades);
      setMsg({
        ok: true,
        text: [body.reset ? "Reset to the default look." : "Saved — live storefront-wide within ~30s.", ...(json.warnings || [])],
      });
    } else {
      setMsg({ ok: false, text: json.errors || [json.error || `Save failed (${res.status})`] });
    }
  }

  return (
    <div className="space-y-5">
      {msg && (
        <div className={`rounded-xl px-4 py-3 text-sm ${msg.ok ? "bg-lime-50 text-lime-700" : "bg-red-50 text-red-600"}`}>
          {msg.text.map((t, i) => (
            <p key={i}>{t}</p>
          ))}
        </div>
      )}

      <section className="rounded-2xl border border-zinc-200 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold">
            Colors{" "}
            {customized && <span className="ml-1 rounded bg-lime-100 px-1.5 py-0.5 text-[10px] font-bold text-lime-700">CUSTOMIZED</span>}
          </h2>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <ColorField label="Accent" value={brand.accent} onChange={set("accent")} hint="One color — the 50–900 ladder derives from it." />
          <ColorField label="Background" value={brand.background} onChange={set("background")} />
          <ColorField label="Text" value={brand.foreground} onChange={set("foreground")} hint="Must pass WCAG AA (4.5:1) on the background." />
        </div>
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Derived accent ladder</p>
          <div className="mt-2 flex overflow-hidden rounded-lg border border-zinc-200">
            {["50", "100", "200", "300", "400", "500", "600", "700", "800", "900"].map((s) => (
              <div key={s} className="h-9 flex-1" style={{ background: shades[s] }} title={`${s} ${shades[s]}`} />
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-200 p-5">
        <h2 className="text-sm font-bold">Shape & type</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Corner radius</span>
            <select value={brand.radius} onChange={(e) => set("radius")(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-2 text-sm">
              {RADII.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Type scale</span>
            <select value={brand.type_scale} onChange={(e) => set("type_scale")(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-2 text-sm">
              {SCALES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4 rounded-xl border border-zinc-100 bg-zinc-50 p-4">
          <p className="text-xs text-zinc-400">Preview</p>
          <div className="mt-2 flex items-center gap-3" style={{ background: brand.background, padding: "12px", borderRadius: "12px" }}>
            <span style={{ color: brand.foreground }} className="text-sm font-medium">
              Body text on your background
            </span>
            <button
              type="button"
              style={{ background: shades["400"], color: brand.accent_label || "#0a0a0b", borderRadius: "9999px" }}
              className="px-4 py-2 text-sm font-bold"
            >
              Buy now
            </button>
          </div>
        </div>
      </section>

      <div className="flex gap-3">
        <button
          onClick={() => call({ brand })}
          disabled={busy}
          className="rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-zinc-700 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save brand"}
        </button>
        <button
          onClick={() => confirm("Reset to the platform default look?") && call({ reset: true })}
          disabled={busy || !customized}
          className="rounded-xl border border-zinc-200 px-5 py-2.5 text-sm font-semibold text-zinc-600 transition hover:bg-zinc-50 disabled:opacity-40"
        >
          Reset to theme
        </button>
      </div>
    </div>
  );
}
