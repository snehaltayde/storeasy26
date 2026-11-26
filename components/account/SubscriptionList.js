"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatMoney } from "@/lib/format";

// Phase 9 line 2: the shopper's subscriptions on /account. Everything comes
// from /api/account/subscriptions (the shopper's own only; money from the
// server). Each one: product, variant, quantity, interval, status, next due
// date and "Next delivery ₹X (price today; confirmed at checkout)", and its
// actions: Pay for this delivery (when due), Skip next, Pause / Resume, Swap,
// Change interval or quantity, and Cancel behind a confirm. Nothing is charged
// automatically.
const dateText = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "");
const STATUS = { active: "Active", paused: "Paused", cancelled: "Cancelled" };
const btn = "sf-focus min-h-11 rounded-sf-small border border-sf-border px-3 py-1.5 text-xs font-semibold text-sf-text-body transition hover:border-sf-border-hover disabled:opacity-50 sm:min-h-0";
const pick = "sf-field mt-1 block max-w-full rounded-sf-small border border-sf-border bg-sf-surface px-2 py-1";

async function post(body) {
  const res = await fetch("/api/account/subscriptions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error === "subscription not found" ? "We couldn't find that subscription. Reload the page." : data.error || "That didn't work. Try again.");
  return data;
}

function Subscription({ s, intervals, quantityMax, reload }) {
  const [panel, setPanel] = useState(null); // pause | swap | change | cancel
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [until, setUntil] = useState("");
  const [options, setOptions] = useState(null);
  const [swapTo, setSwapTo] = useState("");
  const [interval, setIntervalDays] = useState(s.interval);
  const [quantity, setQuantity] = useState(s.quantity);

  async function run(body, after) {
    setBusy(true);
    setError("");
    try {
      const data = await post({ id: s.id, ...body });
      if (after) after(data);
      else {
        setPanel(null);
        await reload();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function openSwap() {
    setPanel("swap");
    if (options) return;
    const res = await fetch(`/api/account/subscriptions?swap=${encodeURIComponent(s.id)}`);
    const d = await res.json().catch(() => ({}));
    setOptions(d.options || []);
  }

  const live = s.status !== "cancelled";
  const intervalChoices = [...new Set([...intervals, s.interval])].sort((a, b) => a - b);
  return (
    <li className="rounded-sf-card border border-sf-border p-4 text-sm sm:p-5" data-subscription={s.id} data-subscription-status={s.status}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {s.handle ? (
              <Link href={`/products/${s.handle}`} className="sf-focus rounded-sf-small hover:underline">
                {s.productTitle}
              </Link>
            ) : (
              s.productTitle
            )}
            {s.variantTitle ? <span className="text-sf-text-muted"> · {s.variantTitle}</span> : null}
          </p>
          <p className="text-sf-text-muted" data-subscription-plan>
            {s.quantity} every {s.interval} days{s.percent ? ` · ${s.percent}% off` : ""}
          </p>
        </div>
        <span className="rounded-sf-2xs bg-sf-surface-sunken px-1.5 py-0.5 text-sf-3xs font-bold uppercase text-sf-text-subtle">{STATUS[s.status] || s.status}</span>
      </div>

      {live && (
        <p className="mt-3 text-sf-text-body">
          {s.status === "paused" ? (
            <>Paused{s.pausedUntil ? ` until ${dateText(s.pausedUntil)}` : " until you resume"}.</>
          ) : (
            <>
              Next delivery due <span data-subscription-due>{dateText(s.nextDueAt)}</span>
            </>
          )}
          {s.next && (
            <>
              {" · "}Next delivery <span className="font-semibold" data-subscription-amount>{formatMoney(s.next.amount, s.next.currency)}</span>{" "}
              <span className="text-sf-text-subtle">(price today; confirmed at checkout)</span>
            </>
          )}
        </p>
      )}
      {live && s.next && !s.next.available && <p className="mt-2 rounded-sf-small bg-sf-surface-muted p-2 text-xs text-sf-warning-strong">This product is sold out right now. You can swap it or skip this delivery.</p>}

      {live && (
        <div className="mt-3 flex flex-wrap gap-2">
          {s.payable && (
            <button type="button" disabled={busy} className="sf-focus min-h-11 rounded-sf-small bg-sf-accent px-3 py-1.5 text-xs font-bold text-sf-on-accent transition hover:bg-sf-accent-hover disabled:opacity-50 sm:min-h-0" data-subscription-pay onClick={() => run({ action: "pay" }, (d) => (window.location.href = d.redirect || "/checkout"))}>
              Pay for this delivery
            </button>
          )}
          {s.status === "active" && (
            <button type="button" disabled={busy} className={btn} data-subscription-skip onClick={() => run({ action: "skip" })}>
              Skip next
            </button>
          )}
          {s.status === "active" ? (
            <button type="button" disabled={busy} className={btn} data-subscription-pause onClick={() => setPanel(panel === "pause" ? null : "pause")}>
              Pause
            </button>
          ) : (
            <button type="button" disabled={busy} className={btn} data-subscription-resume onClick={() => run({ action: "resume" })}>
              Resume
            </button>
          )}
          <button type="button" disabled={busy} className={btn} data-subscription-swap onClick={() => (panel === "swap" ? setPanel(null) : openSwap())}>
            Swap
          </button>
          <button type="button" disabled={busy} className={btn} data-subscription-change onClick={() => setPanel(panel === "change" ? null : "change")}>
            Change interval or quantity
          </button>
          <button type="button" disabled={busy} className={`${btn} text-sf-danger`} data-subscription-cancel onClick={() => setPanel(panel === "cancel" ? null : "cancel")}>
            Cancel
          </button>
        </div>
      )}

      {panel === "pause" && (
        <div className="mt-3 flex flex-wrap items-end gap-2 rounded-sf-control bg-sf-surface-muted p-3">
          <label className="text-sm sm:text-xs">
            Pause until (leave empty to pause until you resume)
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className={pick} />
          </label>
          <button type="button" disabled={busy} className={btn} data-subscription-pause-confirm onClick={() => run({ action: "pause", until: until || null })}>
            Pause subscription
          </button>
        </div>
      )}
      {panel === "swap" && (
        <div className="mt-3 flex flex-wrap items-end gap-2 rounded-sf-control bg-sf-surface-muted p-3">
          {options == null ? (
            <p className="text-xs text-sf-text-subtle" role="status">Loading…</p>
          ) : options.length === 0 ? (
            <p className="text-xs text-sf-text-subtle">There's nothing to swap to right now.</p>
          ) : (
            <>
              <label className="text-sm sm:text-xs">
                Swap to (from the next delivery, at today&rsquo;s price)
                <select value={swapTo} onChange={(e) => setSwapTo(e.target.value)} className={pick} data-subscription-swap-to>
                  <option value="">Choose…</option>
                  {options.map((o) => (
                    <option key={o.variantId} value={o.variantId}>
                      {o.title} · {formatMoney(o.price, s.next?.currency || "INR")} each
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" disabled={busy || !swapTo} className={btn} data-subscription-swap-confirm onClick={() => run({ action: "swap", variantId: swapTo })}>
                Swap
              </button>
            </>
          )}
        </div>
      )}
      {panel === "change" && (
        <div className="mt-3 flex flex-wrap items-end gap-2 rounded-sf-control bg-sf-surface-muted p-3">
          <label className="text-sm sm:text-xs">
            Every
            <select value={interval} onChange={(e) => setIntervalDays(Number(e.target.value))} className={pick} data-subscription-interval>
              {intervalChoices.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm sm:text-xs">
            Quantity
            <select value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} className={pick} data-subscription-quantity>
              {Array.from({ length: quantityMax }, (_, i) => i + 1).map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={busy} className={btn} data-subscription-change-confirm onClick={() => run({ action: "change", interval, quantity })}>
            Save
          </button>
        </div>
      )}
      {panel === "cancel" && (
        <div className="mt-3 rounded-sf-control bg-sf-surface-muted p-3">
          <p className="text-sm sm:text-xs">Cancel this subscription? No more deliveries will be due. Orders you already placed aren&rsquo;t changed.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={busy} className={`${btn} text-sf-danger`} data-subscription-cancel-confirm onClick={() => run({ action: "cancel" })}>
              Yes, cancel it
            </button>
            <button type="button" disabled={busy} className={btn} onClick={() => setPanel(null)}>
              Keep it
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-sf-danger sm:text-xs">
          {error}
        </p>
      )}
    </li>
  );
}

export default function SubscriptionList() {
  const [data, setData] = useState(null);
  const reload = useCallback(async () => {
    const res = await fetch("/api/account/subscriptions");
    setData(res.ok ? await res.json().catch(() => null) : null);
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  if (!data?.subscriptions?.length) return null;
  return (
    <section className="mt-8" data-account-subscriptions>
      <h2 className="text-sm font-bold">Subscriptions</h2>
      <p className="mt-1 text-xs text-sf-text-subtle">You pay for each delivery when it&rsquo;s due. Nothing is charged automatically.</p>
      <ul className="mt-3 space-y-2">
        {data.subscriptions.map((s) => (
          <Subscription key={s.id} s={s} intervals={data.intervals || []} quantityMax={data.quantityMax || 10} reload={reload} />
        ))}
      </ul>
    </section>
  );
}
