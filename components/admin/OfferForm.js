"use client";

import { useState } from "react";
import { CircleAlert, CircleCheck, Plus, TriangleAlert, X } from "lucide-react";
import { PageHeader } from "@/components/console/PageHeader";
import { Card, CardHeader } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { Button, IconButton } from "@/components/console/Button";
import { Switch } from "@/components/console/Switch";
import { Field, Input, Select } from "@/components/console/fields";
import { cx } from "@/components/console/cx";
import { VariantPicker } from "@/components/admin/cms/RefPicker";

// One form, four offer types — fields mirror lib/offers/validate.js exactly.
const TYPES = ["COUPON", "TIERED_QTY", "BXGY", "FREE_GIFT"];
const TARGET_KINDS = ["tag", "handle", "productId", "variantId", "productType"];
const SCOPE = { BXGY: "line", TIERED_QTY: "line", FREE_GIFT: "gift", COUPON: "order" };

// S32 (MC14): proper local↔UTC conversion — an edit round-trip preserves the
// intended instant (the old slice(0,16) version shifted it by the UTC offset).
import { isoToLocalInput as toLocal, localInputToIso as fromLocal } from "@/lib/admin/schedule";

const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

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
  const [giftPickerOpen, setGiftPickerOpen] = useState(false); // S53 B2: the catalog variant picker
  const [code, setCode] = useState(cfg.code || "");
  const [discKind, setDiscKind] = useState(cfg.discount?.kind || "percent");
  const [discValue, setDiscValue] = useState(cfg.discount?.value ?? 10);
  const [minSubtotal, setMinSubtotal] = useState(cfg.minSubtotal ?? "");
  const [combinable, setCombinable] = useState(cfg.combinable !== false);
  const [errors, setErrors] = useState(null); // string[] | null
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

  const [sim, setSim] = useState(null);
  const [simCart, setSimCart] = useState("medium");
  const [simBusy, setSimBusy] = useState(false);

  async function simulate() {
    setSimBusy(true);
    setSim(null);
    try {
      const res = await fetch("/api/admin/offers/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer: buildOffer(), enabled, cartKey: simCart }),
      });
      setSim(await res.json().catch(() => ({ ok: false, errors: ["Simulation failed"] })));
    } catch {
      setSim({ ok: false, errors: ["Simulation request failed — check your connection and try again"] });
    } finally {
      setSimBusy(false);
    }
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setErrors(null);
    const offer = buildOffer();
    const body = JSON.stringify({ offer, enabled, startsAt: fromLocal(startsAt), endsAt: fromLocal(endsAt) });
    try {
      const res = existing
        ? await fetch(`/api/admin/offers/${existing.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body })
        : await fetch("/api/admin/offers", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (res.ok) return onDone();
      const data = await res.json().catch(() => ({}));
      setErrors(data.errors?.length ? data.errors : [data.error || `Save failed (${res.status})`]);
    } catch (err) {
      setErrors([String(err?.message || err)]);
    }
    setBusy(false);
  }

  return (
    <div>
      <PageHeader
        breadcrumb={[
          {
            // the form swaps the view on the SAME route, so the crumb is a
            // real control (back to the list) rather than a same-URL link
            label: (
              <button type="button" onClick={onCancel} className="rounded text-fg-muted focus-ring hover:text-fg hover:underline">
                Offers
              </button>
            ),
          },
          { label: existing ? "Edit" : "New" },
        ]}
        title={existing ? `Edit · ${existing.label}` : "New offer"}
        description={existing ? undefined : "Pick a type, set the rules, prove it on a sample cart, then save."}
      />

      <form onSubmit={save} className="space-y-4">
        <Card>
          <CardHeader title="Basics" description="What the offer is and what shoppers see." />
          <div className="space-y-4">
            {!existing && (
              <div>
                <span className="mb-1 block text-xs font-medium text-fg-muted">Type</span>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Offer type">
                  {TYPES.map((t) => (
                    <button
                      type="button"
                      key={t}
                      onClick={() => setType(t)}
                      aria-pressed={type === t}
                      className={cx(
                        "rounded-ctl border px-3 py-1.5 text-sm font-medium focus-ring motion-safe:transition-colors",
                        type === t ? "border-primary bg-primary text-primary-fg" : "border-edge-strong bg-surface text-fg hover:bg-surface-muted"
                      )}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <Field label="Customer-facing title" htmlFor="offer-title">
              <Input id="offer-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. FESTIVE20 · 20% off" />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Rules" description="Fields mirror the engine's validation exactly." />
          <div className="space-y-4">
            {(type === "BXGY" || type === "TIERED_QTY") && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Target by" htmlFor="offer-target-kind">
                  <Select id="offer-target-kind" value={targetKind} onChange={(e) => setTargetKind(e.target.value)}>
                    {TARGET_KINDS.map((k) => <option key={k}>{k}</option>)}
                  </Select>
                </Field>
                <Field label="Target value" htmlFor="offer-target-value">
                  <Input id="offer-target-value" value={targetValue} onChange={(e) => setTargetValue(e.target.value)} placeholder='e.g. "Whey" or a handle' />
                </Field>
              </div>
            )}

            {type === "BXGY" && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Buy quantity" htmlFor="offer-buy">
                  <Input id="offer-buy" type="number" min="1" value={buy} onChange={(e) => setBuy(e.target.value)} />
                </Field>
                <Field label="Get free" htmlFor="offer-free">
                  <Input id="offer-free" type="number" min="1" value={free} onChange={(e) => setFree(e.target.value)} />
                </Field>
              </div>
            )}

            {type === "TIERED_QTY" && (
              <div>
                <span className="mb-1 block text-xs font-medium text-fg-muted">Tiers (min quantity → % off)</span>
                {tiers.map((t, i) => (
                  <div key={i} className="mb-2 flex items-center gap-2">
                    <Input
                      type="number"
                      min="1"
                      aria-label={`Tier ${i + 1} minimum quantity`}
                      value={t.minQty}
                      onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, minQty: e.target.value } : x)))}
                    />
                    <span className="text-fg-subtle" aria-hidden>→</span>
                    <Input
                      type="number"
                      min="1"
                      max="90"
                      aria-label={`Tier ${i + 1} percent off`}
                      value={t.percent}
                      onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))}
                    />
                    <span className="text-sm text-fg-muted" aria-hidden>%</span>
                    {tiers.length > 1 && (
                      <IconButton
                        label={`Remove tier ${i + 1}`}
                        icon={<X size={14} aria-hidden />}
                        onClick={() => setTiers(tiers.filter((_, j) => j !== i))}
                      />
                    )}
                  </div>
                ))}
                <Button size="sm" variant="ghost" icon={<Plus size={13} aria-hidden />} onClick={() => setTiers([...tiers, { minQty: 2, percent: 5 }])}>
                  Add tier
                </Button>
              </div>
            )}

            {type === "FREE_GIFT" && (
              <>
                <Field label="Subtotal threshold (₹, pre-discount)" htmlFor="offer-threshold">
                  <Input id="offer-threshold" type="number" min="1" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
                </Field>
                <Field label="Gift variant" htmlFor="offer-gift-gid" hint="pick from the catalog, or paste a variant GID">
                  <div className="flex items-center gap-2">
                    <Input id="offer-gift-gid" mono className="flex-1" value={gift.variantId} onChange={(e) => setGift({ ...gift, variantId: e.target.value })} placeholder="gid://shopify/ProductVariant/…" />
                    <Button size="sm" onClick={() => setGiftPickerOpen(true)}>
                      Choose variant…
                    </Button>
                  </div>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Gift title" htmlFor="offer-gift-title">
                    <Input id="offer-gift-title" value={gift.title} onChange={(e) => setGift({ ...gift, title: e.target.value })} />
                  </Field>
                  <Field label="Gift value (₹, for strikethrough)" htmlFor="offer-gift-value">
                    <Input id="offer-gift-value" type="number" value={gift.value} onChange={(e) => setGift({ ...gift, value: e.target.value })} />
                  </Field>
                </div>
                <Field label="Gift image URL (optional)" htmlFor="offer-gift-image">
                  <Input id="offer-gift-image" value={gift.image || ""} onChange={(e) => setGift({ ...gift, image: e.target.value })} />
                </Field>
              </>
            )}

            {type === "COUPON" && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Code" htmlFor="offer-code">
                    <Input id="offer-code" mono value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="FESTIVE20" />
                  </Field>
                  <Field label="Discount" htmlFor="offer-disc-value">
                    <div className="flex gap-2">
                      <Select aria-label="Discount kind" value={discKind} onChange={(e) => setDiscKind(e.target.value)}>
                        <option value="percent">% off</option>
                        <option value="fixed">₹ off</option>
                      </Select>
                      <Input id="offer-disc-value" type="number" min="1" value={discValue} onChange={(e) => setDiscValue(e.target.value)} />
                    </div>
                  </Field>
                </div>
                <div className="grid grid-cols-2 items-end gap-3">
                  <Field label="Min subtotal (₹, optional)" htmlFor="offer-min-subtotal">
                    <Input id="offer-min-subtotal" type="number" min="0" value={minSubtotal} onChange={(e) => setMinSubtotal(e.target.value)} />
                  </Field>
                  <div className="flex items-center gap-2 pb-2">
                    <Switch checked={combinable} onChange={setCombinable} label="Combinable with other offers" />
                    <span className="text-sm text-fg">Combinable with other offers</span>
                  </div>
                </div>
              </>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Schedule" description="Leave both blank to run the offer whenever it's enabled." />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts (optional)" htmlFor="offer-starts">
              <Input id="offer-starts" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </Field>
            <Field label="Ends (optional)" htmlFor="offer-ends">
              <Input id="offer-ends" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </Field>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
            <span className="text-sm text-fg">Enabled</span>
          </div>
        </Card>

        {errors && (
          <Banner tone="danger" title="The offer didn't save">
            <ul className={cx(errors.length > 1 && "list-disc pl-4", "space-y-0.5")}>
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </Banner>
        )}

        {/* S32 (BE07/MC14): prove the offer on a deterministic sample cart
            BEFORE saving — alone and alongside the currently active offers. */}
        <Card>
          <CardHeader
            title="Test on a sample cart"
            description="Runs the real engine on a deterministic basket — nothing is saved."
            actions={
              <>
                <Select aria-label="Sample cart" value={simCart} onChange={(e) => setSimCart(e.target.value)} className="w-auto py-1.5 text-xs">
                  <option value="small">Small basket (₹499)</option>
                  <option value="medium">Medium basket (₹1,897)</option>
                  <option value="large">Large basket (₹4,296)</option>
                </Select>
                <Button size="sm" busy={simBusy} onClick={simulate}>
                  Run simulation
                </Button>
              </>
            }
          />
          {sim && sim.ok === false && (
            <Banner tone="danger" title="Simulation failed">
              <ul className={cx((sim.errors || []).length > 1 && "list-disc pl-4", "space-y-0.5")}>
                {(sim.errors || []).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </Banner>
          )}
          {sim && sim.ok && (
            <ul className="space-y-1.5 text-xs text-fg-muted">
              <li className="flex items-start gap-2">
                {sim.applied.alone ? (
                  <CircleCheck size={14} className="mt-0.5 shrink-0 text-success" aria-hidden />
                ) : (
                  <CircleAlert size={14} className="mt-0.5 shrink-0 text-danger" aria-hidden />
                )}
                <span>
                  <span className="font-semibold text-fg">{sim.applied.alone ? "Applies" : "Does not apply"}</span> on {sim.cart.label}: subtotal{" "}
                  {inr(sim.alone.subtotal)} → discount {inr(sim.alone.discountTotal)} → total {inr(sim.alone.total)}
                  {sim.alone.gifts.length ? ` + gift: ${sim.alone.gifts.map((g) => g.title).join(", ")}` : ""}
                  {` · shipping est. ${inr(sim.alone.shippingEstimate)}`}
                </span>
              </li>
              {sim.activeOfferCount > 0 && (
                <li className="flex items-start gap-2">
                  {sim.applied.combined ? (
                    <CircleCheck size={14} className="mt-0.5 shrink-0 text-success" aria-hidden />
                  ) : (
                    <CircleAlert size={14} className="mt-0.5 shrink-0 text-danger" aria-hidden />
                  )}
                  <span>
                    With the {sim.activeOfferCount} active offer(s):{" "}
                    <span className="font-semibold text-fg">{sim.applied.combined ? "still applies" : "does NOT apply"}</span> — combined discount{" "}
                    {inr(sim.combined.discountTotal)}, total {inr(sim.combined.total)}
                  </span>
                </li>
              )}
              {sim.notes.map((n, i) => (
                <li key={i} className="flex items-start gap-2 text-warning">
                  <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Save offer
          </Button>
        </div>
      </form>

      {/* S53 B2: fills the SAME gift fields the form always saved (variantId,
          productId, handle, title) — a variant is only ever set by an explicit
          click in the picker or by typing; nothing is auto-picked. */}
      <VariantPicker
        open={giftPickerOpen}
        onClose={() => setGiftPickerOpen(false)}
        title="Choose the gift variant"
        selectedVariantId={gift.variantId || undefined}
        onConfirm={({ variantId, productId, productHandle, label }) =>
          setGift((g) => ({ ...g, variantId, productId, handle: productHandle, title: label }))
        }
      />
    </div>
  );
}
