"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// S46 commerce-expansion panels: BundlesPanel + QuizPanel (Catalog tab) and
// ReturnsPanel (top of Orders). All three talk to their /api/admin/* routes;
// money never moves from any of them.

const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

const btn = "rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-50 disabled:opacity-40";
const btnDark = "rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-40";
const input = "rounded-lg border border-zinc-200 px-2 py-1.5 text-sm outline-none focus:border-zinc-400";

function ErrorLine({ err }) {
  return err ? <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{err}</p> : null;
}

// ---- Bundles (BE31 + SF18) ----------------------------------------------------

const EMPTY_BUNDLE = { id: null, slug: "", title: "", description: "", bundle_price: "", items: [{ variantId: "", quantity: 1 }, { variantId: "", quantity: 1 }] };

export function BundlesPanel({ initial }) {
  const [bundles, setBundles] = useState(initial || []);
  const [form, setForm] = useState(null); // null = closed
  const [compat, setCompat] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  async function refresh() {
    const data = await fetch("/api/admin/bundles").then((r) => r.json()).catch(() => null);
    if (data?.ok) setBundles(data.bundles);
  }

  async function post(body) {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/admin/bundles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setErr(json.error || "Request failed");
      return null;
    }
    return json;
  }

  async function check() {
    const r = await post({ check: { items: form.items, bundle_price: Number(form.bundle_price) } });
    if (r) setCompat(r.compat);
  }

  async function save(enable) {
    const r = await post({ bundle: { ...form, bundle_price: Number(form.bundle_price), enable } });
    if (r) {
      setForm(null);
      setCompat(null);
      await refresh();
    }
  }

  return (
    <section className="rounded-2xl border border-zinc-200 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold">Bundles</h2>
        <button type="button" className={btn} onClick={() => { setForm(EMPTY_BUNDLE); setCompat(null); setErr(null); }}>
          New bundle
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        A bundle is a set price for a fixed group of variants — applied automatically in the cart through the
        offers engine. Enabling checks that every component is live and the price actually saves.
      </p>

      {bundles.length === 0 && !form && <p className="mt-3 text-sm text-zinc-400">No bundles yet.</p>}
      <ul className="mt-3 space-y-2">
        {bundles.map((b) => (
          <li key={b.id} className="rounded-xl border border-zinc-100 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{b.title}</span>
              <span className="text-xs text-zinc-400">/bundles/{b.slug}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${b.enabled ? "bg-lime-100 text-lime-700" : "bg-zinc-100 text-zinc-500"}`}>{b.enabled ? "live" : "draft"}</span>
              <span className="ml-auto text-xs text-zinc-500">
                {inr(b.bundle_price)} {b.compat?.componentsSum ? <s className="text-zinc-400">{inr(b.compat.componentsSum)}</s> : null}
              </span>
            </div>
            {!b.compat?.ok && (
              <p className="mt-1 text-xs text-amber-700">⚠ {b.compat?.problems?.join(" · ") || "components unavailable"} — {b.enabled ? "shoppers see it as unavailable" : "can't be enabled"}</p>
            )}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className={btn}
                disabled={busy}
                onClick={async () => {
                  const r = await post({ enable: { id: b.id, enabled: !b.enabled } });
                  if (r) await refresh();
                }}
              >
                {b.enabled ? "Disable" : "Enable"}
              </button>
              <button type="button" className={btn} onClick={() => { setForm({ id: b.id, slug: b.slug, title: b.title, description: b.description || "", bundle_price: b.bundle_price, items: b.items }); setCompat(null); setErr(null); }}>
                Edit
              </button>
              <button
                type="button"
                className={`${btn} text-red-600`}
                disabled={busy}
                onClick={async () => {
                  if (confirmDelete !== b.id) {
                    setConfirmDelete(b.id);
                    setErr(`Click again to remove "${b.title}" (its offer goes too).`);
                    return;
                  }
                  const r = await post({ remove: { id: b.id } });
                  setConfirmDelete(null);
                  setErr(null);
                  if (r) await refresh();
                }}
              >
                {confirmDelete === b.id ? "Really delete?" : "Delete"}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {form && (
        <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <input className={input} placeholder="slug (e.g. starter-stack)" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
            <input className={input} placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <input className={`${input} sm:col-span-2`} placeholder="Description (shown on the bundle page)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <input className={input} type="number" min="1" placeholder="Bundle price (₹)" value={form.bundle_price} onChange={(e) => setForm({ ...form, bundle_price: e.target.value })} />
          </div>
          <p className="mt-3 text-xs font-semibold text-zinc-600">Components — a product handle (first variant) or a variant ID, plus quantity</p>
          {form.items.map((c, i) => (
            <div key={i} className="mt-1.5 flex gap-2">
              <input className={`${input} flex-1 font-mono text-xs`} placeholder="product-handle or gid://shopify/ProductVariant/…" value={c.variantId} onChange={(e) => setForm({ ...form, items: form.items.map((x, j) => (j === i ? { ...x, variantId: e.target.value.trim() } : x)) })} />
              <input className={`${input} w-16`} type="number" min="1" value={c.quantity} onChange={(e) => setForm({ ...form, items: form.items.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) || 1 } : x)) })} />
              {form.items.length > 2 && (
                <button type="button" className={btn} onClick={() => setForm({ ...form, items: form.items.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              )}
            </div>
          ))}
          <button type="button" className={`${btn} mt-2`} onClick={() => setForm({ ...form, items: [...form.items, { variantId: "", quantity: 1 }] })}>
            + component
          </button>

          {compat && (
            <div className={`mt-3 rounded-lg px-3 py-2 text-xs ${compat.ok ? "bg-lime-50 text-lime-800" : "bg-amber-50 text-amber-800"}`}>
              {compat.ok ? (
                <>✓ compatible — components sum to {inr(compat.componentsSum)}, shoppers save {inr(compat.saving)}</>
              ) : (
                <>✗ {compat.problems.join(" · ")}</>
              )}
              {compat.components?.length > 0 && (
                <ul className="mt-1 text-zinc-600">
                  {compat.components.map((c, i) => (
                    <li key={i}>
                      {c.title ? `${c.title}${c.variant_title && c.variant_title !== "Default Title" ? ` — ${c.variant_title}` : ""} ×${c.quantity} (${inr(c.price)})` : `component ${i + 1}: not found`}
                      {c.state === "missing" ? " · missing" : c.available === false ? " · sold out" : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <ErrorLine err={err} />
          <div className="mt-3 flex gap-2">
            <button type="button" className={btn} disabled={busy} onClick={check}>
              Check compatibility
            </button>
            <button type="button" className={btn} disabled={busy} onClick={() => save(false)}>
              Save draft
            </button>
            <button type="button" className={btnDark} disabled={busy} onClick={() => save(true)}>
              Save &amp; enable
            </button>
            <button type="button" className={btn} onClick={() => { setForm(null); setCompat(null); setErr(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!form && <ErrorLine err={err} />}
    </section>
  );
}

// ---- Quiz editor (SF19) -------------------------------------------------------

const EMPTY_QUIZ = { slug: "", title: "", intro: "", enabled: true, questions: [{ prompt: "", options: [{ label: "", tags: "" }, { label: "", tags: "" }] }] };

const toEditor = (q) => ({ ...q, questions: q.questions.map((qq) => ({ prompt: qq.prompt, options: qq.options.map((o) => ({ label: o.label, tags: (o.tags || []).join(", ") })) })) });
const fromEditor = (q) => ({ slug: q.slug, title: q.title, intro: q.intro, questions: q.questions.map((qq) => ({ prompt: qq.prompt, options: qq.options.map((o) => ({ label: o.label, tags: o.tags.split(",").map((t) => t.trim()).filter(Boolean) })) })) });

export function QuizPanel({ initial }) {
  const [quizzes, setQuizzes] = useState(initial || []);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function refresh() {
    const data = await fetch("/api/admin/quiz").then((r) => r.json()).catch(() => null);
    if (data?.ok) setQuizzes(data.quizzes);
  }

  async function post(body) {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/admin/quiz", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setErr(json.error || "Request failed");
      return null;
    }
    return json;
  }

  async function openEdit(slug) {
    const data = await fetch(`/api/admin/quiz?slug=${encodeURIComponent(slug)}`).then((r) => r.json()).catch(() => null);
    if (data?.ok) setForm(toEditor(data.quiz));
  }

  const setQ = (i, patch) => setForm({ ...form, questions: form.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
  const setOpt = (i, k, patch) => setQ(i, { options: form.questions[i].options.map((o, l) => (l === k ? { ...o, ...patch } : o)) });

  return (
    <section className="mt-4 rounded-2xl border border-zinc-200 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold">Product-finder quiz</h2>
        <button type="button" className={btn} onClick={() => { setForm(EMPTY_QUIZ); setErr(null); }}>
          New quiz
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Deterministic — options carry catalog tags, answers tally tags, and the top tags pick matching
        available products. Same answers, same picks, every time. Lives at /quiz/&lt;slug&gt;.
      </p>

      {quizzes.length === 0 && !form && <p className="mt-3 text-sm text-zinc-400">No quizzes yet.</p>}
      <ul className="mt-3 space-y-1.5 text-sm">
        {quizzes.map((q) => (
          <li key={q.slug} className="flex items-center gap-2">
            <span className="font-semibold">{q.title}</span>
            <span className="text-xs text-zinc-400">/quiz/{q.slug}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${q.enabled ? "bg-lime-100 text-lime-700" : "bg-zinc-100 text-zinc-500"}`}>{q.enabled ? "live" : "off"}</span>
            <span className="ml-auto flex gap-2">
              <button type="button" className={btn} onClick={() => openEdit(q.slug)}>
                Edit
              </button>
              <button
                type="button"
                className={`${btn} text-red-600`}
                disabled={busy}
                onClick={async () => {
                  const r = await post({ remove: { slug: q.slug } });
                  if (r) await refresh();
                }}
              >
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>

      {form && (
        <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <input className={input} placeholder="slug (e.g. find-your-stack)" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
            <input className={input} placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <input className={`${input} sm:col-span-2`} placeholder="Intro (optional)" value={form.intro} onChange={(e) => setForm({ ...form, intro: e.target.value })} />
          </div>
          {form.questions.map((q, i) => (
            <div key={i} className="mt-3 rounded-lg border border-zinc-200 bg-white p-2.5">
              <div className="flex gap-2">
                <input className={`${input} flex-1`} placeholder={`Question ${i + 1}`} value={q.prompt} onChange={(e) => setQ(i, { prompt: e.target.value })} />
                {form.questions.length > 1 && (
                  <button type="button" className={btn} onClick={() => setForm({ ...form, questions: form.questions.filter((_, j) => j !== i) })}>
                    ✕
                  </button>
                )}
              </div>
              {q.options.map((o, k) => (
                <div key={k} className="mt-1.5 flex gap-2 pl-3">
                  <input className={`${input} flex-1`} placeholder={`Option ${k + 1}`} value={o.label} onChange={(e) => setOpt(i, k, { label: e.target.value })} />
                  <input className={`${input} flex-1`} placeholder="tags, comma, separated" value={o.tags} onChange={(e) => setOpt(i, k, { tags: e.target.value })} />
                  {q.options.length > 2 && (
                    <button type="button" className={btn} onClick={() => setQ(i, { options: q.options.filter((_, l) => l !== k) })}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {q.options.length < 6 && (
                <button type="button" className={`${btn} mt-1.5 ml-3`} onClick={() => setQ(i, { options: [...q.options, { label: "", tags: "" }] })}>
                  + option
                </button>
              )}
            </div>
          ))}
          {form.questions.length < 10 && (
            <button type="button" className={`${btn} mt-2`} onClick={() => setForm({ ...form, questions: [...form.questions, { prompt: "", options: [{ label: "", tags: "" }, { label: "", tags: "" }] }] })}>
              + question
            </button>
          )}
          <label className="mt-3 flex items-center gap-2 text-xs text-zinc-600">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> live on the storefront
          </label>
          <ErrorLine err={err} />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className={btnDark}
              disabled={busy}
              onClick={async () => {
                const r = await post({ quiz: fromEditor(form), enabled: form.enabled });
                if (r) {
                  setForm(null);
                  await refresh();
                }
              }}
            >
              Save quiz
            </button>
            <button type="button" className={btn} onClick={() => { setForm(null); setErr(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!form && <ErrorLine err={err} />}
    </section>
  );
}

// ---- Returns (SF21) -----------------------------------------------------------

const RETURN_CHIP = {
  requested: "bg-amber-100 text-amber-700",
  approved: "bg-lime-100 text-lime-700",
  completed: "bg-emerald-100 text-emerald-700",
  rejected: "bg-zinc-100 text-zinc-400",
};

export function ReturnsPanel({ initial }) {
  const router = useRouter();
  const [returns, setReturns] = useState(initial || []);
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const open = returns.filter((r) => ["requested", "approved"].includes(r.status));
  const closed = returns.filter((r) => !["requested", "approved"].includes(r.status));
  if (!returns.length) return null;

  async function decide(id, action) {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/admin/returns", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action, note: notes[id] || "" }) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setErr(json.error || "Request failed");
      return;
    }
    const data = await fetch("/api/admin/returns").then((r) => r.json()).catch(() => null);
    if (data?.ok) setReturns(data.returns);
    router.refresh();
  }

  const Row = ({ r, actions }) => (
    <li className="rounded-xl border border-zinc-100 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${RETURN_CHIP[r.status]}`}>{r.status}</span>
        <span className="font-semibold">{r.order_id}</span>
        <span className="text-xs text-zinc-400">{new Date(r.created_at).toLocaleDateString("en-IN")}</span>
        <span className="ml-auto text-xs text-zinc-500">
          {inr(r.total)}
          {Number(r.refunded_total) > 0 && <span className="text-red-500"> · {inr(r.refunded_total)} refunded</span>}
        </span>
      </div>
      <p className="mt-1 text-zinc-600">“{r.reason}”</p>
      {r.note && <p className="mt-0.5 text-xs text-zinc-400">note: {r.note}</p>}
      {actions && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input className={`${input} min-w-40 flex-1`} placeholder="Note to the shopper (optional)" value={notes[r.id] || ""} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
          {r.status === "requested" && (
            <button type="button" className={btnDark} disabled={busy} onClick={() => decide(r.id, "approve")}>
              Approve
            </button>
          )}
          {r.status === "approved" && (
            <button type="button" className={btnDark} disabled={busy} onClick={() => decide(r.id, "complete")}>
              Mark received
            </button>
          )}
          <button type="button" className={btn} disabled={busy} onClick={() => decide(r.id, "reject")}>
            Reject
          </button>
        </div>
      )}
    </li>
  );

  return (
    <section className="mx-auto mb-2 max-w-4xl px-4 pt-4 sm:px-6">
      <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4">
        <h2 className="text-sm font-bold">Return requests</h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          Approving authorizes the physical return only — it moves <strong>no money</strong>. Refund through the
          provider as usual; the order mirrors it automatically.
        </p>
        <ErrorLine err={err} />
        <ul className="mt-3 space-y-2">
          {open.map((r) => (
            <Row key={r.id} r={r} actions />
          ))}
        </ul>
        {closed.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-zinc-400">Resolved ({closed.length})</summary>
            <ul className="mt-2 space-y-2">
              {closed.map((r) => (
                <Row key={r.id} r={r} />
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
