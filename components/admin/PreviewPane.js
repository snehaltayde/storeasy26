"use client";

import { useState } from "react";

// Draft preview pane (S37 / MC08): mints an S36 preview token, follows the
// cookie-setting redirect with a same-origin fetch, then iframes the real
// storefront — REAL bindings (catalog, cart, offers), responsive widths.
const DEVICES = [
  { key: "mobile", label: "Mobile", width: 375 },
  { key: "tablet", label: "Tablet", width: 768 },
  { key: "desktop", label: "Desktop", width: "100%" },
];

export default function PreviewPane() {
  const [open, setOpen] = useState(false);
  const [device, setDevice] = useState("desktop");
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/releases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!json.url) throw new Error(json.error || "could not mint a preview link");
      await fetch(json.url, { redirect: "follow" }); // sets the httpOnly preview cookie
      setOpen(true);
      setNonce((n) => n + 1);
    } catch (e) {
      setErr(String(e.message || e));
    }
    setBusy(false);
  }

  const width = DEVICES.find((d) => d.key === device)?.width ?? "100%";

  return (
    <section className="rounded-2xl border border-zinc-200 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-bold">Draft preview</h2>
        <span className="text-xs text-zinc-400">your browser only — shoppers keep seeing the live release</span>
        <span className="ml-auto flex items-center gap-1">
          {open &&
            DEVICES.map((d) => (
              <button
                key={d.key}
                type="button"
                onClick={() => setDevice(d.key)}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${device === d.key ? "bg-zinc-900 text-white" : "text-zinc-500 hover:bg-zinc-100"}`}
              >
                {d.label}
              </button>
            ))}
          {open && (
            <button type="button" onClick={() => setNonce((n) => n + 1)} className="rounded-lg px-2.5 py-1 text-xs font-semibold text-zinc-500 hover:bg-zinc-100">
              ⟳ Refresh
            </button>
          )}
          <button type="button" onClick={open ? () => setOpen(false) : start} disabled={busy} className="rounded-lg border border-zinc-200 px-3 py-1 text-xs font-bold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">
            {open ? "Close" : busy ? "Opening…" : "Open preview"}
          </button>
        </span>
      </div>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      {open && (
        <div className="mt-4 overflow-auto rounded-xl border border-zinc-200 bg-zinc-100 p-3">
          <iframe
            key={nonce}
            src="/"
            title="Draft preview"
            style={{ width: typeof width === "number" ? `${width}px` : width }}
            className="mx-auto block h-[600px] rounded-lg border border-zinc-300 bg-white shadow-sm"
          />
        </div>
      )}
    </section>
  );
}
