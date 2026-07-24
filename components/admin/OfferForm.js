"use client";

import { useState } from "react";

// One form, four offer types — fields mirror lib/offers/validate.js exactly.
const TYPES = ["COUPON", "TIERED_QTY", "BXGY", "FREE_GIFT"];
const TARGET_KINDS = ["tag", "handle", "productId", "variantId", "productType"];
const SCOPE = { BXGY: "line", TIERED_QTY: "line", FREE_GIFT: "gift", COUPON: "order" };

const toLocal = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16) : "");
const fromLocal = (v) => (v ? new Date(v).toISOString() : null);

export default function OfferForm({ existing, onDone, onCancel }) {
  const cfg = existing?.config || {};
  const [type, setType] = useState(existing?.type || "COUPON");
  const [id, setId] = useState(existing?.id || "");
  const [title, setTitle] = useState(cfg.title || "");
  const [enabled, setEnabled] = useState(existing ? existing.enabled : true);
  const [startsAt, setStartsAt] = useState(toLocal(existing?.starts_at));
  const [endsAt, setEndsAt] = useState(toLocal(existing?.ends_at));
  // type-specific state
  const [targetKind, setTargetKind] = useState(cfg.target?.kind || "tag");
  const [targetValue, setTargetValue] = useState(cfg.target?.value || "");
  const [buy, setBuy] = useState(cfg.buy ?? 2);
  const [free, setFree] = useState(cfg.free ?? 1);
  const [tiers, setTiers] = useState(cfg.tiers || [{ minQty: 2, percent: 5 }]);
  const [threshold, setThreshold] = useState(cfg.threshold ?? 1499);
  const [gift, setGift] = useState(cfg.gift || { variantId: "", title: "", value: 0, image: "", productId: "", handle: "" });
  const [code, setCode] = useState(cfg.code || "");
  const [discKind, setDiscKind] = useState(cfg.discount?.kind || "percent");
  const [discValue, setDiscValue] = useState(cfg.discount?.value ?? 10);
  const [minSubtotal, setMinSubtotal] = useState(cfg.minSubtotal ?? "");
  const [combinable, setCombinable] = useState(cfg.combinable !== false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function buildOffer() {
    const base = {
      id: id || `${type.toLowerCase().replace(/_/g, "-")}-${(type === "COUPON" ? code : targetValue || "offer").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 60),
      type,
      scope: SCOPE[type],
      priority: cfg.priority ?? (type === "COUPON" ? 50 : type === "FREE_GIFT" ? 40 : 30),
      title,
    };
    if (type === "BXGY") return { ...base, target: { kind: targetKind, value: targetValue }, buy: Number(buy), free: Number(free) };
    if (type === "TIERED_QTY")
      return { ...base, target: { kind: targetKind, value: targetValue }, tiers: tiers.map((t) => ({ minQty: Number(t.minQty), percent: Number(t.percent) })) };
    if (type === "FREE_GIFT") return { ...base, threshold: Number(threshold), gift: { ...gift, value: Number(gift.value) || 0 } };
    return {
      ...base,
      code: code.toUpperCase(),
      discount: { kind: discKind, value: Number(discValue) },
      ...(minSubtotal !== "" ? { minSubtotal: Number(minSubtotal) } : {}),
      combinable,
    };
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const offer = buildOffer();
    const body = JSON.stringify({ offer, enabled, startsAt: fromLocal(startsAt), endsAt: fromLocal(endsAt) });
    const res = existing
      ? await fetch(`/api/admin/offers/${existing.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body })
      : await fetch("/api/admin/offers", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if (res.ok) return onDone();
    const data = await res.json().catch(() => ({}));
    setError(data.errors?.join("\n") || data.error || `Save failed (${res.status})`);
    setBusy(false);
  }

  const input = "w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400";
  const label = "mb-1 block text-xs font-medium text-zinc-500";

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold">{existing ? `Edit · ${existing.label}` : "New offer"}</h1>
      <form onSubmit={save} className="mt-6 space-y-5">
        {!existing && (
          <div>
            <span className={label}>Type</span>
            <div className="flex flex-wrap gap-2">
              {TYPES.map((t) => (
                <button type="button" key={t} onClick={() => setType(t)}
                  className={`rounded-xl border px-3 py-1.5 text-sm font-semibold ${type === t ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300"}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <span className={label}>Customer-facing title</span>
          <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. FESTIVE20 · 20% off" />
        </div>

        {(type === "BXGY" || type === "TIERED_QTY") && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={label}>Target by</span>
              <select className={input} value={targetKind} onChange={(e) => setTargetKind(e.target.value)}>
                {TARGET_KINDS.map((k) => <option key={k}>{k}</option>)}
              </select>
            </div>
            <div>
              <span className={label}>Target value</span>
              <input className={input} value={targetValue} onChange={(e) => setTargetValue(e.target.value)} placeholder='e.g. "Whey" or a handle' />
            </div>
          </div>
        )}

        {type === "BXGY" && (
          <div className="grid grid-cols-2 gap-3">
            <div><span className={label}>Buy quantity</span><input type="number" min="1" className={input} value={buy} onChange={(e) => setBuy(e.target.value)} /></div>
            <div><span className={label}>Get free</span><input type="number" min="1" className={input} value={free} onChange={(e) => setFree(e.target.value)} /></div>
          </div>
        )}

        {type === "TIERED_QTY" && (
          <div>
            <span className={label}>Tiers (min quantity → % off)</span>
            {tiers.map((t, i) => (
              <div key={i} className="mb-2 flex items-center gap-2">
                <input type="number" min="1" className={input} value={t.minQty} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, minQty: e.target.value } : x)))} />
                <span className="text-zinc-400">→</span>
                <input type="number" min="1" max="90" className={input} value={t.percent} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))} />
                <span className="text-sm text-zinc-500">%</span>
                {tiers.length > 1 && (
                  <button type="button" onClick={() => setTiers(tiers.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-red-600">✕</button>
                )}
              </div>
            ))}
            <button type="button" onClick={() => setTiers([...tiers, { minQty: 2, percent: 5 }])} className="text-sm font-medium text-lime-700 hover:underline">
              + Add tier
            </button>
          </div>
        )}

        {type === "FREE_GIFT" && (
          <>
            <div><span className={label}>Subtotal threshold (₹, pre-discount)</span><input type="number" min="1" className={input} value={threshold} onChange={(e) => setThreshold(e.target.value)} /></div>
            <div><span className={label}>Gift variant GID</span><input className={input} value={gift.variantId} onChange={(e) => setGift({ ...gift, variantId: e.target.value })} placeholder="gid://shopify/ProductVariant/…" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><span className={label}>Gift title</span><input className={input} value={gift.title} onChange={(e) => setGift({ ...gift, title: e.target.value })} /></div>
              <div><span className={label}>Gift value (₹, for strikethrough)</span><input type="number" className={input} value={gift.value} onChange={(e) => setGift({ ...gift, value: e.target.value })} /></div>
            </div>
            <div><span className={label}>Gift image URL (optional)</span><input className={input} value={gift.image || ""} onChange={(e) => setGift({ ...gift, image: e.target.value })} /></div>
          </>
        )}

        {type === "COUPON" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div><span className={label}>Code</span><input className={input} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="FESTIVE20" /></div>
              <div>
                <span className={label}>Discount</span>
                <div className="flex gap-2">
                  <select className={input} value={discKind} onChange={(e) => setDiscKind(e.target.value)}>
                    <option value="percent">% off</option>
                    <option value="fixed">₹ off</option>
                  </select>
                  <input type="number" min="1" className={input} value={discValue} onChange={(e) => setDiscValue(e.target.value)} />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><span className={label}>Min subtotal (₹, optional)</span><input type="number" min="0" className={input} value={minSubtotal} onChange={(e) => setMinSubtotal(e.target.value)} /></div>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input type="checkbox" checked={combinable} onChange={(e) => setCombinable(e.target.checked)} />
                Combinable with other offers
              </label>
            </div>
          </>
        )}

        <div className="grid grid-cols-2 gap-3 border-t border-zinc-100 pt-4">
          <div><span className={label}>Starts (optional)</span><input type="datetime-local" className={input} value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></div>
          <div><span className={label}>Ends (optional)</span><input type="datetime-local" className={input} value={endsAt} onChange={(e) => setEndsAt(e.target.value)} /></div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>

        {error && <pre className="whitespace-pre-wrap rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</pre>}

        <div className="flex gap-3">
          <button type="submit" disabled={busy} className="rounded-xl bg-zinc-900 px-6 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
            {busy ? "Saving…" : "Save offer"}
          </button>
          <button type="button" onClick={onCancel} className="rounded-xl border border-zinc-300 px-6 py-2.5 text-sm font-semibold hover:bg-zinc-50">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
