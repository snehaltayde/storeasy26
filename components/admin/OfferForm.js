"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, CircleCheck, Plus, RotateCcw, TriangleAlert, X } from "lucide-react";
import { PageHeader } from "@/components/console/PageHeader";
import { Card, CardHeader } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { Badge } from "@/components/console/Badge";
import { Button, IconButton } from "@/components/console/Button";
import { Switch } from "@/components/console/Switch";
import { ConfirmDialog, Dialog } from "@/components/console/Dialog";
import { Field, Input, Select } from "@/components/console/fields";
import { SkeletonText, EmptyState } from "@/components/console/bits";
import { cx } from "@/components/console/cx";
import { ProductPicker, VariantPicker } from "@/components/admin/cms/RefPicker";
import { OFFER_KINDS, OFFER_TYPE_NAMES, currencySign, defaultOfferTitle, money, offerDetails, offerSentence, offerWarnings, plainErrors, staleNameWarning } from "@/lib/offers/plain";
import { TARGET_CHOICES, formFromOffer, formProblems, newOfferId, offerFromForm, randomSuffix, reachOf, sameSettings, schedulePayload, updateForm, when } from "./offerFormModel";

// Start an offer in plain words, safely (COM-03). The founder picks what the
// offer is for, sees it as one sentence and as an example cart built from the
// store's own products, and only then starts it: the primary button sits
// below both. Offers go live on save (OQ-03), so editing a live one shows the
// old and new sentences side by side, "Turn off" stays at the top, and the
// settings from before the last change are one click away. No raw target
// kinds and no identifiers: every product, size, tag, type and gift is picked.

const scheduleText = (startsAt, endsAt) => {
  if (!startsAt && !endsAt) return "Runs whenever it's on.";
  if (startsAt && endsAt) return `Runs from ${when(startsAt)} to ${when(endsAt)}.`;
  return startsAt ? `Starts ${when(startsAt)}.` : `Ends ${when(endsAt)}.`;
};

export default function OfferForm({ existing, onDone, onCancel, onChanged, currency = "INR", names = {}, offers = [] }) {
  // an automatic name opens blank, so it follows the rules the founder changes
  const [form, setForm] = useState(() => formFromOffer(existing, { names, currency }));
  const set = (patch) => setForm((f) => updateForm(f, patch));
  const [suffix] = useState(() => randomSuffix());
  const [picked, setPicked] = useState({}); // names of things picked in this form
  const [picker, setPicker] = useState(null); // product | variant | tag | type | gift | null
  const [targetOptions, setTargetOptions] = useState(null);
  const [optionsError, setOptionsError] = useState(null);
  const [sim, setSim] = useState(null);
  const [simBusy, setSimBusy] = useState(false);
  const simSeq = useRef(0);
  const [errors, setErrors] = useState(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(existing ? !!existing.enabled : true);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState(null);
  const [confirmRevert, setConfirmRevert] = useState(false);

  const allNames = { ...names, ...picked };
  const say = { names: allNames, currency };
  const sign = currencySign(currency);
  const id = existing ? existing.id : null;
  const draft = form.type ? offerFromForm(form, { id: id || "new-offer", ...say }) : null;
  // P4-FIX5: never an id another offer of this store already uses
  const takenIds = offers.map((o) => o?.id).filter(Boolean);
  const offer = draft ? { ...draft, id: id || newOfferId(draft, { names: allNames, suffix, taken: takenIds }) } : null;
  const problems = formProblems(form, offer, { currency });
  const sentence = offer ? offerSentence(offer, say) : null;
  const details = offer ? offerDetails(offer) : [];
  const schedule = schedulePayload(form);

  // the example cart, from this store's products, as the founder edits
  const simKey = offer && !problems.length ? JSON.stringify(offer) : "";
  async function simulate() {
    if (!simKey) return;
    const key = simKey; // the result belongs to these exact rules
    const seq = ++simSeq.current;
    setSimBusy(true);
    try {
      const res = await fetch("/api/admin/offers/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer, enabled: live }),
      });
      const data = await res.json().catch(() => ({ ok: false, errors: ["The example couldn't be worked out. Try again."] }));
      if (seq === simSeq.current) setSim({ ...data, key });
    } catch {
      if (seq === simSeq.current) setSim({ ok: false, key, errors: ["The example couldn't load. Check your connection and try again."] });
    } finally {
      if (seq === simSeq.current) setSimBusy(false);
    }
  }
  useEffect(() => {
    if (!simKey) {
      simSeq.current++;
      setSim(null);
      setSimBusy(false);
      return;
    }
    const h = setTimeout(simulate, 350);
    return () => clearTimeout(h);
    // simulate reads the offer behind simKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simKey]);
  // An example for rules the founder has since changed is never shown next
  // to the new sentence: until the new one arrives, the form says it's checking.
  const simFresh = Boolean(sim && sim.key === simKey);

  const codeTaken =
    offer?.type === "COUPON" && offer.code && offers.some((o) => o.id !== id && o.type === "COUPON" && String(o.config?.code || "").toUpperCase() === offer.code);
  // editing: the live settings against the new ones
  const oldSentence = existing ? offerSentence(existing.config, say) || existing.label : null;
  const oldName = existing ? existing.config?.title || existing.label : null;
  const changed =
    existing &&
    offer &&
    !(sameSettings(offer, existing.config) && (schedule.startsAt || null) === (existing.starts_at || null) && (schedule.endsAt || null) === (existing.ends_at || null));
  const previousSentence = existing?.previous ? offerSentence(existing.previous.config, say) || existing.previous.label : null;
  // going back: do shoppers really get the earlier settings, and when?
  const previousReach = existing?.previous ? reachOf({ enabled: live, starts_at: existing.previous.starts_at, ends_at: existing.previous.ends_at }) : null;

  // a name the founder typed that mentions a number, product, gift or code the edit changed
  const staleName = existing && changed && form.title.trim() ? staleNameWarning(form.title, existing.config, offer, say) : null;
  const warnings = offer
    ? [
        ...offerWarnings(offer, { currency, freeItemValue: simFresh && sim.ok ? sim.facts?.maxTargetPrice : null }),
        ...(codeTaken ? [`Another offer already uses the code ${offer.code}. Shoppers can only get one of them.`] : []),
        ...(staleName ? [staleName] : []),
      ]
    : [];

  const primaryLabel = !existing ? "Start offer" : live ? "Update live offer" : "Save changes";

  async function loadTargetOptions() {
    if (targetOptions) return;
    setOptionsError(null);
    try {
      const res = await fetch("/api/admin/offers/targets");
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "Your tags and types couldn't load.");
      setTargetOptions({ tags: data.tags || [], types: data.types || [] });
    } catch (e) {
      setOptionsError(String(e?.message || e));
    }
  }
  function openPicker(which) {
    setPicker(which);
    if (which === "tag" || which === "type") loadTargetOptions();
  }
  function pickTarget(target) {
    if (target.label) setPicked((p) => ({ ...p, [target.value]: target.label }));
    set({ target });
  }

  async function save(e) {
    e?.preventDefault?.();
    if (problems.length) {
      setErrors(problems);
      return;
    }
    setBusy(true);
    setErrors(null);
    const body = JSON.stringify({ offer, enabled: existing ? live : true, ...schedule });
    try {
      const res = existing
        ? await fetch(`/api/admin/offers/${existing.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body })
        : await fetch("/api/admin/offers", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setBusy(false);
        return onDone?.({ offer: data.offer, created: !existing });
      }
      setErrors(data.errors?.length ? plainErrors(data.errors, { currency }) : [data.error || "The offer didn't save. Try again."]);
    } catch {
      setErrors(["The offer didn't save. Check your connection and try again."]);
    }
    setBusy(false);
  }

  async function toggleLive() {
    setToggling(true);
    setToggleError(null);
    try {
      const res = await fetch(`/api/admin/offers/${existing.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !live }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "That didn't work. Try again.");
      setLive(!live);
      onChanged?.();
    } catch (err) {
      setToggleError(String(err?.message || err));
    } finally {
      setToggling(false);
    }
  }

  async function revert() {
    // the earlier settings this page shows; the server refuses if they've
    // changed since, so shoppers never get something the dialog didn't name
    const res = await fetch(`/api/admin/offers/${existing.id}/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expect: existing.previous?.replaced_at ?? null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "That didn't work. Try again.");
    onChanged?.();
    return onDone?.({ offer: data.offer, reverted: true });
  }

  const choice = TARGET_CHOICES.find((c) => c.key === form.choice) || TARGET_CHOICES[0];
  const targetLabel = form.target ? (form.target.kind === "tag" || form.target.kind === "productType" ? form.target.value : allNames[form.target.value] || form.target.label || "The chosen product") : null;

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
        title={existing ? existing.label : "New offer"}
        description={existing ? undefined : "Choose the kind of offer and what it's for. Check the sentence and the example, then start it."}
        actions={
          existing ? (
            <>
              <Badge tone={live ? "success" : "neutral"}>{live ? "Live" : "Off"}</Badge>
              <Button variant={live ? "dangerOutline" : "secondary"} busy={toggling} onClick={toggleLive}>
                {live ? "Turn off" : "Turn on"}
              </Button>
            </>
          ) : null
        }
      />

      <div className="space-y-4">
        {toggleError && <Banner tone="danger">{toggleError}</Banner>}
        {existing && (
          <Banner tone={live ? "info" : "neutral"}>
            {live ? "This offer is live. Shoppers get your changes on their next cart once you update it." : "This offer is off. Shoppers don't get it until you turn it on."}
          </Banner>
        )}

        {existing?.previous && previousSentence && (
          <Card>
            <CardHeader
              title="Before your last change"
              description={existing.previous.replaced_at ? `Changed ${when(existing.previous.replaced_at)}` : undefined}
              actions={
                <Button size="sm" icon={<RotateCcw size={13} aria-hidden />} onClick={() => setConfirmRevert(true)}>
                  Go back to previous offer settings
                </Button>
              }
            />
            <p className="text-sm text-fg" data-sentence="previous">
              {previousSentence}
            </p>
            <p className="mt-1 text-xs text-fg-muted">{scheduleText(existing.previous.starts_at, existing.previous.ends_at)}</p>
          </Card>
        )}

        <form onSubmit={save} className="space-y-4">
          <Card>
            <CardHeader title="What kind of offer?" />
            {existing ? (
              <p className="text-sm text-fg">{OFFER_TYPE_NAMES[form.type] || form.type}</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Kind of offer">
                {OFFER_KINDS.map((k) => (
                  <button
                    type="button"
                    key={k.type}
                    onClick={() => set({ type: k.type })}
                    aria-pressed={form.type === k.type}
                    className={cx(
                      "rounded-ctl border px-3 py-2.5 text-left focus-ring motion-safe:transition-colors",
                      form.type === k.type ? "border-primary bg-surface-sunken" : "border-edge-strong bg-surface hover:bg-surface-muted"
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
                      {form.type === k.type && <Check size={14} aria-hidden />}
                      {k.name}
                    </span>
                    <span className="mt-0.5 block text-xs text-fg-muted">{k.hint}</span>
                  </button>
                ))}
              </div>
            )}
          </Card>

          {form.type && (
            <Card>
              <CardHeader title="The rules" />
              <div className="space-y-4">
                {(form.type === "BXGY" || form.type === "TIERED_QTY") && (
                  <div className="space-y-2">
                    <span className="block text-xs font-medium text-fg-muted">What is it for?</span>
                    <div className="flex flex-wrap gap-2" role="group" aria-label="What the offer is for">
                      {TARGET_CHOICES.map((c) => (
                        <button
                          type="button"
                          key={c.key}
                          onClick={() => set({ choice: c.key })}
                          aria-pressed={form.choice === c.key}
                          className={cx(
                            "rounded-ctl border px-3 py-1.5 text-sm focus-ring motion-safe:transition-colors",
                            form.choice === c.key ? "border-primary bg-primary text-primary-fg" : "border-edge-strong bg-surface text-fg hover:bg-surface-muted"
                          )}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-fg-subtle">{choice.hint}</p>
                    <div className="flex flex-wrap items-center gap-2 rounded-ctl border border-edge bg-surface-sunken px-3 py-2">
                      <span className={cx("min-w-0 flex-1 truncate text-sm", targetLabel ? "font-medium text-fg" : "text-fg-subtle")} data-picked="target">
                        {targetLabel || "Nothing chosen yet"}
                      </span>
                      <Button size="sm" onClick={() => openPicker(form.choice)}>
                        {form.target ? "Change" : form.choice === "tag" ? "Choose a tag" : form.choice === "type" ? "Choose a type" : form.choice === "variant" ? "Choose a size or option" : "Choose a product"}
                      </Button>
                    </div>
                  </div>
                )}

                {form.type === "BXGY" && (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Shopper buys" htmlFor="offer-buy">
                      <Input id="offer-buy" type="number" min="1" step="1" inputMode="numeric" value={form.buy} onChange={(e) => set({ buy: e.target.value })} />
                    </Field>
                    <Field label="And gets free" htmlFor="offer-free">
                      <Input id="offer-free" type="number" min="1" step="1" inputMode="numeric" value={form.free} onChange={(e) => set({ free: e.target.value })} />
                    </Field>
                  </div>
                )}

                {form.type === "TIERED_QTY" && (
                  <div>
                    <span className="mb-1 block text-xs font-medium text-fg-muted">Steps</span>
                    {form.tiers.map((tier, i) => (
                      <div key={i} className="mb-2 flex flex-wrap items-center gap-2 text-sm text-fg">
                        <span>Buy</span>
                        <Input
                          type="number"
                          min="1"
                          step="1"
                          inputMode="numeric"
                          className="w-20"
                          aria-label={`Step ${i + 1}: how many to buy`}
                          value={tier.minQty}
                          onChange={(e) => set({ tiers: form.tiers.map((x, j) => (j === i ? { ...x, minQty: e.target.value } : x)) })}
                        />
                        <span>or more, get</span>
                        <Input
                          type="number"
                          min="1"
                          max="90"
                          inputMode="decimal"
                          className="w-20"
                          aria-label={`Step ${i + 1}: percent off`}
                          value={tier.percent}
                          onChange={(e) => set({ tiers: form.tiers.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)) })}
                        />
                        <span>% off</span>
                        {form.tiers.length > 1 && (
                          <IconButton label={`Remove step ${i + 1}`} icon={<X size={14} aria-hidden />} onClick={() => set({ tiers: form.tiers.filter((_, j) => j !== i) })} />
                        )}
                      </div>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Plus size={13} aria-hidden />}
                      onClick={() => {
                        const last = form.tiers[form.tiers.length - 1];
                        set({ tiers: [...form.tiers, { minQty: String((Number(last?.minQty) || 1) + 1), percent: String(Math.min(90, (Number(last?.percent) || 5) + 5)) }] });
                      }}
                    >
                      Add a step
                    </Button>
                  </div>
                )}

                {form.type === "FREE_GIFT" && (
                  <>
                    <Field label={`Cart total over (${sign})`} htmlFor="offer-threshold" hint="Counted before any discounts.">
                      <Input id="offer-threshold" type="number" min="1" inputMode="decimal" value={form.threshold} onChange={(e) => set({ threshold: e.target.value })} />
                    </Field>
                    <div className="space-y-1">
                      <span className="block text-xs font-medium text-fg-muted">The free gift</span>
                      <div className="flex flex-wrap items-center gap-2 rounded-ctl border border-edge bg-surface-sunken px-3 py-2">
                        <span className={cx("min-w-0 flex-1 truncate text-sm", form.gift?.title ? "font-medium text-fg" : "text-fg-subtle")} data-picked="gift">
                          {form.gift?.title || "Nothing chosen yet"}
                        </span>
                        <Button size="sm" onClick={() => openPicker("gift")}>
                          {form.gift ? "Change" : "Choose the gift"}
                        </Button>
                      </div>
                    </div>
                    {form.gift && (
                      <Field label={`Gift is worth (${sign})`} htmlFor="offer-gift-value" hint="Shown crossed out next to the gift. We filled in its price.">
                        <Input id="offer-gift-value" type="number" min="0" inputMode="decimal" value={str(form.gift.value)} onChange={(e) => set({ gift: { ...form.gift, value: e.target.value } })} />
                      </Field>
                    )}
                  </>
                )}

                {form.type === "COUPON" && (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Code shoppers type" htmlFor="offer-code" hint={form.codeAuto ? "We suggested one. Change it if you like." : "3 to 20 letters or numbers."}>
                        <Input id="offer-code" value={form.code} onChange={(e) => set({ code: e.target.value.toUpperCase().replace(/\s+/g, "") })} />
                      </Field>
                      <Field label="Discount" htmlFor="offer-disc-value">
                        <div className="flex gap-2">
                          <Select aria-label="Kind of discount" className="w-auto" value={form.discKind} onChange={(e) => set({ discKind: e.target.value })}>
                            <option value="percent">% off</option>
                            <option value="fixed">{sign} off</option>
                          </Select>
                          <Input id="offer-disc-value" type="number" min="1" inputMode="decimal" value={form.discValue} onChange={(e) => set({ discValue: e.target.value })} />
                        </div>
                      </Field>
                    </div>
                    <div className="grid items-end gap-3 sm:grid-cols-2">
                      <Field label={`Minimum order (${sign}, optional)`} htmlFor="offer-min-subtotal">
                        <Input id="offer-min-subtotal" type="number" min="0" inputMode="decimal" value={form.minSubtotal} onChange={(e) => set({ minSubtotal: e.target.value })} />
                      </Field>
                      <div className="flex items-center gap-2 pb-2">
                        <Switch checked={form.combinable} onChange={(v) => set({ combinable: v })} label="Works with other offers" />
                        <span className="text-sm text-fg">Works with other offers</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </Card>
          )}

          {form.type && (
            <Card>
              <CardHeader title="What shoppers see, and when" />
              <div className="space-y-4">
                <Field
                  label="Name in the cart (optional)"
                  htmlFor="offer-title"
                  hint={!form.title.trim() && offer?.title ? `Leave it blank to use “${offer.title}”. It changes when the rules do.` : undefined}
                >
                  <Input id="offer-title" value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder={(offer && defaultOfferTitle(offer, say)) || "Filled in for you"} />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Starts (optional)" htmlFor="offer-starts">
                    <Input id="offer-starts" type="datetime-local" value={form.startsAt} onChange={(e) => set({ startsAt: e.target.value })} />
                  </Field>
                  <Field label="Ends (optional)" htmlFor="offer-ends">
                    <Input id="offer-ends" type="datetime-local" value={form.endsAt} onChange={(e) => set({ endsAt: e.target.value })} />
                  </Field>
                </div>
                <p className="text-xs text-fg-muted">{scheduleText(schedule.startsAt, schedule.endsAt)}</p>
              </div>
            </Card>
          )}

          {form.type && (
            <Card>
              <CardHeader
                title={existing ? "Check before you update" : "Check before you start"}
                actions={
                  simKey ? (
                    <Button size="sm" variant="ghost" busy={simBusy} onClick={simulate}>
                      Check again
                    </Button>
                  ) : null
                }
              />
              <div className="space-y-4">
                {existing ? (
                  <div className="grid gap-3 sm:grid-cols-2" data-compare="sentences">
                    <div className="rounded-ctl border border-edge p-3">
                      <p className="text-xs font-medium text-fg-muted">{live ? "Live now" : "Saved now"}</p>
                      <p className="mt-1 text-sm text-fg" data-sentence="old">
                        {oldSentence}
                      </p>
                      <p className="mt-1 text-xs text-fg-muted">
                        Name in the cart: <span data-name="old">{oldName}</span>
                      </p>
                      <p className="mt-1 text-xs text-fg-muted">{scheduleText(existing.starts_at, existing.ends_at)}</p>
                    </div>
                    <div className={cx("rounded-ctl border p-3", changed ? "border-primary" : "border-edge")}>
                      <p className="text-xs font-medium text-fg-muted">{live ? "After you update" : "After you save"}</p>
                      <p className="mt-1 text-sm font-medium text-fg" data-sentence="new">
                        {sentence || "Finish the rules to see this."}
                      </p>
                      {offer?.title && (
                        <p className={cx("mt-1 text-xs", offer.title !== oldName ? "font-medium text-fg" : "text-fg-muted")}>
                          Name in the cart: <span data-name="new">{offer.title}</span>
                        </p>
                      )}
                      <p className="mt-1 text-xs text-fg-muted">{changed ? scheduleText(schedule.startsAt, schedule.endsAt) : "No changes yet."}</p>
                    </div>
                  </div>
                ) : (
                  <p className={cx("text-base", sentence ? "font-semibold text-fg" : "text-fg-subtle")} data-sentence="new">
                    {sentence || "Finish the rules to see the offer in one sentence."}
                  </p>
                )}
                {details.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-fg-muted">
                    {details.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                )}

                <div data-simulator="result">
                  <p className="mb-1.5 text-xs font-medium text-fg-muted">Example from your store</p>
                  {!simKey ? (
                    <p className="text-sm text-fg-subtle">The example appears when the rules are complete.</p>
                  ) : !simFresh ? (
                    <p className="text-sm text-fg-subtle" aria-live="polite">
                      Checking on your store&rsquo;s products…
                    </p>
                  ) : sim.ok === false ? (
                    <Banner tone="danger" title="The example couldn't be worked out">
                      <ul className="space-y-0.5">
                        {plainErrors(sim.errors || [sim.error], { currency }).map((m, i) => (
                          <li key={i}>{m}</li>
                        ))}
                      </ul>
                    </Banner>
                  ) : (
                    <SimulatorResult sim={sim} />
                  )}
                </div>

                {warnings.length > 0 && (
                  <Banner tone="warning" title="Check this is right">
                    <ul className="space-y-0.5">
                      {warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </Banner>
                )}
                {problems.length > 0 && (
                  <div className="rounded-ctl border border-edge bg-surface-sunken px-3 py-2">
                    <p className="text-xs font-medium text-fg-muted">Still to do</p>
                    <ul className="mt-1 space-y-0.5 text-sm text-fg">
                      {problems.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </Card>
          )}

          {errors && (
            <Banner tone="danger" title="The offer didn't save">
              <ul className={cx(errors.length > 1 && "list-disc pl-4", "space-y-0.5")}>
                {errors.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </Banner>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {!existing && form.type && !problems.length && <p className="mr-auto text-xs text-fg-muted">{schedule.startsAt ? `It goes live ${when(schedule.startsAt)}.` : "It goes live for shoppers straight away."}</p>}
            <Button onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            {form.type && (
              <Button type="submit" variant="primary" busy={busy} disabled={problems.length > 0 || Boolean(existing && !changed)}>
                {primaryLabel}
              </Button>
            )}
          </div>
        </form>
      </div>

      <ProductPicker
        open={picker === "product"}
        onClose={() => setPicker(null)}
        title="Choose the product"
        onConfirm={([item]) => item && pickTarget({ kind: "productId", value: item.id, label: item.title })}
      />
      <VariantPicker
        open={picker === "variant"}
        onClose={() => setPicker(null)}
        title="Choose the size or option"
        selectedVariantId={form.target?.kind === "variantId" ? form.target.value : undefined}
        onConfirm={({ variantId, label }) => pickTarget({ kind: "variantId", value: variantId, label })}
      />
      <ValuePicker
        open={picker === "tag" || picker === "type"}
        onClose={() => setPicker(null)}
        title={picker === "type" ? "Choose a product type" : "Choose a tag"}
        options={targetOptions ? (picker === "type" ? targetOptions.types : targetOptions.tags) : null}
        error={optionsError}
        onRetry={() => {
          setTargetOptions(null);
          loadTargetOptions();
        }}
        selected={form.target?.value}
        onPick={(value) => pickTarget({ kind: picker === "type" ? "productType" : "tag", value })}
      />
      {/* fills the same gift fields the form always saved; nothing is auto-picked */}
      <VariantPicker
        open={picker === "gift"}
        onClose={() => setPicker(null)}
        title="Choose the free gift"
        selectedVariantId={form.gift?.variantId || undefined}
        onConfirm={({ variantId, productId, productHandle, label, variant, product }) =>
          set({
            gift: {
              variantId,
              productId,
              handle: productHandle,
              title: label,
              value: variant?.price ?? product?.price_min ?? 0,
              image: variant?.thumb || product?.thumb || "",
            },
          })
        }
      />
      <ConfirmDialog
        open={confirmRevert}
        onClose={() => setConfirmRevert(false)}
        title="Go back to previous offer settings?"
        confirmLabel="Go back"
        body={
          <>
            <span className="block">
              {!previousReach ? "Shoppers get this on their next cart:" : previousReach.why === "later" ? `Shoppers get this from ${when(existing.previous.starts_at)}:` : "Going back to:"}
            </span>
            <span className="mt-1 block font-medium text-fg">{previousSentence}</span>
            {previousReach && previousReach.why !== "later" && (
              <span className="mt-2 block text-warning">
                {previousReach.why === "ended"
                  ? `Its dates ended ${when(existing.previous.ends_at)}, so shoppers won't get it after you go back. You can change the dates afterwards.`
                  : "This offer is off, so shoppers won't get it until you turn it on."}
              </span>
            )}
            {changed && <span className="mt-2 block text-warning">The changes you haven't saved here will be lost.</span>}
            <span className="mt-2 block">Your saved settings are kept, so you can switch back the same way.</span>
          </>
        }
        onConfirm={revert}
      />
    </div>
  );
}

const str = (v) => (v == null ? "" : String(v));

function SimulatorResult({ sim }) {
  if (sim.missing && !sim.example) return <p className="text-sm text-fg-muted">{sim.missing}</p>;
  const rows = sim.steps?.length > 1 ? sim.steps : [sim.example];
  return (
    <ul className="space-y-1.5 text-sm">
      {rows.map((ex, i) => (
        <li key={i} className="flex items-start gap-2" data-example={ex.agrees ? "agrees" : "differs"}>
          {ex.agrees ? <CircleCheck size={15} className="mt-0.5 shrink-0 text-success" aria-hidden /> : <CircleAlert size={15} className="mt-0.5 shrink-0 text-danger" aria-hidden />}
          <span className="text-fg">
            {ex.text}
            {!ex.agrees && (
              <span className="block text-danger">
                The cart worked this out differently ({money(ex.alone.discountTotal, sim.currency)} off). Check the offer before you start it.
              </span>
            )}
          </span>
        </li>
      ))}
      {sim.nearMiss && (
        <li className="flex items-start gap-2 text-fg-muted" data-example={sim.nearMiss.agrees ? "agrees" : "differs"}>
          <span className="mt-0.5 inline-block size-[15px] shrink-0" aria-hidden />
          <span>{sim.nearMiss.text}</span>
        </li>
      )}
      {(sim.notes || []).map((n, i) => (
        <li key={`n${i}`} className="flex items-start gap-2 text-warning">
          <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span>{n}</span>
        </li>
      ))}
    </ul>
  );
}

// Pick one of the store's tags or product types (the RefPicker dialog, for
// values instead of catalog records).
function ValuePicker({ open, onClose, title, options, error, onRetry, selected, onPick }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const visible = (options || []).filter((o) => !needle || o.value.toLowerCase().includes(needle));
  return (
    <Dialog open={open} onClose={onClose} title={title} size="lg">
      <div className="space-y-3">
        <Input type="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        {error && (
          <Banner tone="danger" actions={<Button size="sm" onClick={onRetry}>Try again</Button>}>
            {error}
          </Banner>
        )}
        {!error && !options && <SkeletonText lines={4} />}
        {options && visible.length === 0 && <EmptyState className="py-6" title={needle ? "No matches" : "None in your store yet"} body={needle ? "Try a different search." : "Add them to your products in Shopify, then sync."} />}
        {options && visible.length > 0 && (
          <ul className="max-h-80 divide-y divide-edge overflow-y-auto rounded-ctl border border-edge">
            {visible.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  aria-pressed={o.value === selected}
                  onClick={() => {
                    onPick(o.value);
                    onClose();
                  }}
                  className={cx("flex w-full items-center gap-3 px-3 py-2 text-left text-sm focus-ring", o.value === selected ? "bg-surface-sunken" : "hover:bg-surface-sunken")}
                >
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">{o.value}</span>
                  <span className="shrink-0 text-xs text-fg-muted">
                    {o.count} product{o.count === 1 ? "" : "s"}
                  </span>
                  {o.value === selected && <Check size={14} className="shrink-0 text-success" aria-hidden />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
