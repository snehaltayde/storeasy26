"use client";

import { useState } from "react";

// Experiments console (S47 / MC18). The UI repeats what the engine
// enforces: the plan freezes at start, no winner talk while running or
// under-sampled or SRM-flagged, adoption = a DRAFT the Releases tab ships.
const btn = "rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-50 disabled:opacity-40";
const btnDark = "rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-40";
const input = "w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-sm outline-none focus:border-zinc-400";

const STATUS_CHIP = {
  draft: "bg-zinc-100 text-zinc-500",
  running: "bg-lime-100 text-lime-700",
  paused: "bg-amber-100 text-amber-700",
  completed: "bg-sky-100 text-sky-700",
};

const EMPTY = {
  slug: "",
  name: "",
  hypothesis: "",
  target_kind: "hero",
  min_sample: 200,
  variants: [
    { key: "control", weight: 50 },
    { key: "b", weight: 50, payload: { title: "", highlight: "", subtitle: "" } },
  ],
};

export default function ExperimentsAdmin({ initial }) {
  const [experiments, setExperiments] = useState(initial || []);
  const [form, setForm] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function refresh() {
    const data = await fetch("/api/admin/experiments").then((r) => r.json()).catch(() => null);
    if (data?.ok) setExperiments(data.experiments);
  }

  async function post(body) {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/admin/experiments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setErr(json.error || "Request failed");
      return null;
    }
    return json;
  }

  async function analyze(slug) {
    const data = await fetch(`/api/admin/experiments?analyze=${encodeURIComponent(slug)}`).then((r) => r.json()).catch(() => null);
    if (data?.ok) setAnalysis(data.analysis);
  }

  const setVariant = (i, patch) => setForm({ ...form, variants: form.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)) });

  return (
    <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Experiments</h1>
        <button type="button" className={btn} onClick={() => { setForm(EMPTY); setErr(null); }}>
          New experiment
        </button>
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        A/B tests on the home hero. The plan (hypothesis, allocation, minimum sample) freezes when you start;
        winner talk is blocked while running, under-sampled, or when exposure ratios look broken. Adopting a
        variant saves a <strong>draft</strong> — it goes live through Releases, like any edit.
      </p>

      {experiments.length === 0 && !form && <p className="mt-6 text-sm text-zinc-400">No experiments yet.</p>}
      <ul className="mt-5 space-y-2">
        {experiments.map((e) => (
          <li key={e.id} className="rounded-xl border border-zinc-200 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${STATUS_CHIP[e.status]}`}>{e.status}</span>
              <span className="font-semibold">{e.name}</span>
              <span className="text-xs text-zinc-400">{e.slug} · {e.target_kind} · {e.variants.map((v) => `${v.key} ${v.weight}%`).join(" / ")}</span>
              {e.adopted_variant && <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">adopted: {e.adopted_variant}</span>}
              <span className="ml-auto flex gap-2">
                {e.status === "draft" && (
                  <>
                    <button type="button" className={btn} onClick={() => { setForm({ slug: e.slug, name: e.name, hypothesis: e.hypothesis || "", target_kind: e.target_kind, min_sample: e.min_sample, variants: e.variants }); setErr(null); }}>
                      Edit
                    </button>
                    <button type="button" className={btnDark} disabled={busy} onClick={async () => (await post({ start: { slug: e.slug } })) && refresh()}>
                      Start
                    </button>
                  </>
                )}
                {e.status === "running" && (
                  <button type="button" className={btn} disabled={busy} onClick={async () => (await post({ pause: { slug: e.slug } })) && refresh()}>
                    Pause
                  </button>
                )}
                {e.status === "paused" && (
                  <button type="button" className={btn} disabled={busy} onClick={async () => (await post({ start: { slug: e.slug } })) && refresh()}>
                    Resume
                  </button>
                )}
                {["running", "paused"].includes(e.status) && (
                  <button type="button" className={btn} disabled={busy} onClick={async () => (await post({ complete: { slug: e.slug } })) && refresh()}>
                    Complete
                  </button>
                )}
                <button type="button" className={btn} onClick={() => analyze(e.slug)}>
                  Results
                </button>
              </span>
            </div>
            {e.hypothesis && <p className="mt-1 text-xs text-zinc-500">Hypothesis: {e.hypothesis}</p>}

            {analysis?.slug === e.slug && (
              <div className="mt-3 rounded-lg bg-zinc-50 p-3">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-zinc-400">
                      <th className="py-1 font-medium">variant</th>
                      <th className="font-medium">exposed</th>
                      <th className="font-medium">orders</th>
                      <th className="font-medium">rate</th>
                      <th className="font-medium">sample</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.cells.map((c) => (
                      <tr key={c.key} className="border-t border-zinc-100">
                        <td className="py-1 font-semibold">{c.key}</td>
                        <td>{c.exposed}</td>
                        <td>{c.conversions}</td>
                        <td>{(c.rate * 100).toFixed(2)}%</td>
                        <td className={c.exposed >= analysis.min_sample ? "text-lime-600" : "text-amber-600"}>
                          {c.exposed >= analysis.min_sample ? "✓" : `${c.exposed}/${analysis.min_sample}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-zinc-500">
                  Exposure ratio check: {analysis.srm.ok ? `passing (χ²=${analysis.srm.chi2})` : `FAILING (χ²=${analysis.srm.chi2})`}
                </p>
                {analysis.interpretationBlocked.length > 0 ? (
                  <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    <p className="font-semibold">No winner interpretation:</p>
                    <ul className="mt-0.5 list-disc pl-4">
                      {analysis.interpretationBlocked.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800">{analysis.verdict.note}</p>
                )}
                {e.status === "completed" && !e.adopted_variant && (
                  <div className="mt-2 flex gap-2">
                    {analysis.cells.map((c) => (
                      <button key={c.key} type="button" className={btn} disabled={busy} onClick={async () => { const r = await post({ adopt: { slug: e.slug, variant: c.key } }); if (r) { setErr(r.note); await refresh(); } }}>
                        Adopt {c.key}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {form && (
        <div className="mt-5 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <input className={input} placeholder="slug (e.g. hero-urgency)" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
            <input className={input} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <textarea className={`${input} min-h-16 sm:col-span-2`} placeholder="Hypothesis — required before start (the plan freezes with it)" value={form.hypothesis} onChange={(e) => setForm({ ...form, hypothesis: e.target.value })} />
            <label className="text-xs text-zinc-600">
              Min sample per variant
              <input className={input} type="number" min="50" value={form.min_sample} onChange={(e) => setForm({ ...form, min_sample: Number(e.target.value) || 200 })} />
            </label>
          </div>
          {form.variants.map((v, i) => (
            <div key={i} className="mt-3 rounded-lg border border-zinc-200 bg-white p-2.5">
              <div className="flex items-center gap-2">
                <input className={`${input} w-28`} disabled={i === 0} value={v.key} onChange={(e) => setVariant(i, { key: e.target.value })} />
                <label className="flex items-center gap-1 text-xs text-zinc-500">
                  weight
                  <input className={`${input} w-16`} type="number" min="1" value={v.weight} onChange={(e) => setVariant(i, { weight: Number(e.target.value) || 1 })} />
                  %
                </label>
                {i === 0 ? <span className="text-xs text-zinc-400">serves the live hero unchanged</span> : form.variants.length > 2 && (
                  <button type="button" className={btn} onClick={() => setForm({ ...form, variants: form.variants.filter((_, j) => j !== i) })}>
                    ✕
                  </button>
                )}
              </div>
              {i > 0 && (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <input className={input} placeholder="Hero title" value={v.payload?.title || ""} onChange={(e) => setVariant(i, { payload: { ...v.payload, title: e.target.value } })} />
                  <input className={input} placeholder="Highlight (substring of the title)" value={v.payload?.highlight || ""} onChange={(e) => setVariant(i, { payload: { ...v.payload, highlight: e.target.value } })} />
                  <input className={`${input} sm:col-span-2`} placeholder="Subtitle" value={v.payload?.subtitle || ""} onChange={(e) => setVariant(i, { payload: { ...v.payload, subtitle: e.target.value } })} />
                </div>
              )}
            </div>
          ))}
          {form.variants.length < 6 && (
            <button type="button" className={`${btn} mt-2`} onClick={() => setForm({ ...form, variants: [...form.variants, { key: `v${form.variants.length}`, weight: 10, payload: { title: "", highlight: "", subtitle: "" } }] })}>
              + variant
            </button>
          )}
          {err && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{err}</p>}
          <div className="mt-3 flex gap-2">
            <button type="button" className={btnDark} disabled={busy} onClick={async () => { const r = await post({ experiment: form }); if (r) { setForm(null); await refresh(); } }}>
              Save draft
            </button>
            <button type="button" className={btn} onClick={() => { setForm(null); setErr(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!form && err && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{err}</p>}
    </div>
  );
}
