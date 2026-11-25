"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/kit/page-header";
import { RoleGate } from "@/components/kit/role-gate";
import { StatusBadge, offerState } from "@/components/kit/status-badge";
import { cn } from "@/components/ui/utils";
import { useToast } from "@/components/console/Toast";
import { doneMessage, formFromOffer, formProblems, newOfferId, offerFromForm, randomSuffix, reachOf, sameSettings, updateForm } from "@/components/admin/offerFormModel";
import { currencySign, defaultOfferTitle, offerDetails, offerSentence, offerWarnings, plainErrors, staleNameWarning } from "@/lib/offers/plain";
import { ConfirmAction, sendJson, useLeaveGuard } from "./ConfirmAction";
import { OfferKindPicker } from "./OfferKindPicker";
import { RefCombobox, loadVariants } from "./RefCombobox";
import { ScheduleField, isoToZoned, scheduleText, whenIn, zonedToIso } from "./ScheduleField";
import { SimulatePanel } from "./SimulatePanel";
import { TargetField, WholeCart } from "./TargetField";

// Create or edit one offer (Phase 2 line 4; the rules of COM-03's form on the
// new UI). New: pick the kind, then its rules, what it is for, the name and
// the schedule in store time; the live sentence, warnings and "Try it" sit
// above Save. Edit adds the live and new sentences side by side, on/off,
// "Go back to previous settings" (revert with `expect`; a 409 CHANGED is the
// server's plain words), and Delete. Every refusal is plain words
// (plainErrors) and nothing typed is lost; leaving with unsaved changes asks
// first. Support (canWrite false) sees the same page with every field
// disabled and no switch, Save, Delete or revert; "Try it" still works.
const NO_WRITE = "Your role can look at offers but not change them.";
const str = (v) => (v == null ? "" : String(v));

function Field({ id, label, hint, children, className }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Section({ title, description, children, actions }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {actions}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

const initialForm = (existing, opts, tz) => ({ ...formFromOffer(existing, opts), startsAt: isoToZoned(existing?.starts_at, tz), endsAt: isoToZoned(existing?.ends_at, tz) });

export function OfferEditor({ existing = null, offers = [], names = {}, currency, timezone, role, canWrite }) {
  const router = useRouter();
  const toast = useToast();
  const tz = timezone;
  const [start] = useState(() => initialForm(existing, { names, currency }, tz));
  const [form, setForm] = useState(start);
  const set = (patch) => setForm((f) => updateForm(f, patch));
  const [suffix] = useState(() => randomSuffix());
  const [picked, setPicked] = useState({});
  const [targetOptions, setTargetOptions] = useState(null);
  const [optionsError, setOptionsError] = useState(null);
  const [sim, setSim] = useState(null);
  const [errors, setErrors] = useState(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(existing ? !!existing.enabled : true);
  const [toggleError, setToggleError] = useState(null);
  const [ask, setAsk] = useState(null); // "off" | "revert" | "delete" | "leave"

  const allNames = { ...names, ...picked };
  const say = { names: allNames, currency };
  const sign = currencySign(currency);
  const id = existing?.id || null;
  const draft = form.type ? offerFromForm(form, { id: id || "new-offer", ...say }) : null;
  const takenIds = offers.map((o) => o?.id).filter(Boolean);
  const offer = draft ? { ...draft, id: id || newOfferId(draft, { names: allNames, suffix, taken: takenIds }) } : null;
  const problems = formProblems(form, offer, { currency });
  const schedule = { startsAt: zonedToIso(form.startsAt, tz), endsAt: zonedToIso(form.endsAt, tz) };
  const sentence = offer ? offerSentence(offer, say) : null;
  const details = offer ? offerDetails(offer) : [];
  const dirty = JSON.stringify(form) !== JSON.stringify(start);
  const changed = existing && offer && !(sameSettings(offer, existing.config) && (schedule.startsAt || null) === (existing.starts_at || null) && (schedule.endsAt || null) === (existing.ends_at || null));
  const codeTaken = offer?.type === "COUPON" && offer.code && offers.some((o) => o.id !== id && o.type === "COUPON" && String(o.config?.code || "").toUpperCase() === offer.code);
  const staleName = existing && changed && form.title.trim() ? staleNameWarning(form.title, existing.config, offer, say) : null;
  const warnings = offer
    ? [...offerWarnings(offer, { currency, freeItemValue: sim?.facts?.maxTargetPrice ?? null }), ...(codeTaken ? [`Another offer already uses the code ${offer.code}. Shoppers can only get one of them.`] : []), ...(staleName ? [staleName] : [])]
    : [];
  const oldSentence = existing ? offerSentence(existing.config, say) || existing.label : null;
  const previousSentence = existing?.previous ? offerSentence(existing.previous.config, say) || existing.previous.label : null;
  const previousReach = existing?.previous ? reachOf({ enabled: live, starts_at: existing.previous.starts_at, ends_at: existing.previous.ends_at }) : null;
  const state = existing ? offerState({ enabled: live, starts_at: existing.starts_at, ends_at: existing.ends_at }) : null;
  const ro = !canWrite;
  const leaving = useLeaveGuard(dirty && !ro);

  async function loadTargetOptions() {
    setOptionsError(null);
    try {
      const data = await sendJson("/api/admin/offers/targets", "GET");
      setTargetOptions({ tags: data.tags || [], types: data.types || [] });
    } catch {
      setOptionsError("Your tags and types couldn't load.");
    }
  }
  useEffect(() => {
    if ((form.choice === "tag" || form.choice === "type") && !targetOptions && !optionsError) loadTargetOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.choice]);

  const back = (message) => {
    leaving.current = true;
    if (message) toast.success(message);
    router.push("/admin/offers");
    router.refresh();
  };

  async function save() {
    if (problems.length) return setErrors(problems);
    setBusy(true);
    setErrors(null);
    try {
      const body = { offer, enabled: existing ? live : true, ...schedule };
      const data = existing ? await sendJson(`/api/admin/offers/${encodeURIComponent(id)}`, "PUT", body) : await sendJson("/api/admin/offers", "POST", body);
      back(doneMessage({ offer: data.offer, created: !existing }));
    } catch (e) {
      const errs = e.body?.errors;
      setErrors(errs?.length ? plainErrors(errs, { currency }) : [e.message || "The offer didn't save. Try again."]);
      setBusy(false);
    }
  }

  async function setEnabled(next) {
    setToggleError(null);
    try {
      await sendJson(`/api/admin/offers/${encodeURIComponent(id)}`, "PUT", { enabled: next });
      setLive(next);
      router.refresh();
    } catch (e) {
      setToggleError(e.message);
      throw e;
    }
  }

  const targetLabel = form.target ? (form.target.kind === "tag" || form.target.kind === "productType" ? form.target.value : allNames[form.target.value] || form.target.label || "The chosen product") : null;
  const primaryLabel = !existing ? "Start offer" : live ? "Update live offer" : "Save changes";
  const title = existing ? existing.label : "New offer";
  const setTier = (i, patch) => set({ tiers: form.tiers.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        breadcrumb={[{ label: "Offers", href: "/admin/offers" }, { label: existing ? "Edit" : "New" }]}
        title={title}
        description={existing ? (ro ? "You can look at this offer and try it, but not change it." : undefined) : "Choose the kind of offer and what it's for. Check the sentence and the example, then start it."}
        actions={
          existing ? (
            <>
              <StatusBadge kind="offer" status={state} />
              {canWrite && (
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={live} aria-label={live ? "Turn this offer off" : "Turn this offer on"} data-offer-switch="detail" onCheckedChange={(v) => (v ? setEnabled(true).catch(() => {}) : setAsk("off"))} />
                  {live ? "On" : "Off"}
                </label>
              )}
              <RoleGate role={role} action="offers.write" mode="hide" reason={NO_WRITE}>
                <Button type="button" variant="destructive" onClick={() => setAsk("delete")}>
                  <Trash2 aria-hidden /> Delete
                </Button>
              </RoleGate>
            </>
          ) : null
        }
      />

      <div className="space-y-4">
        {toggleError && (
          <p role="alert" className="text-sm text-destructive">
            {toggleError}
          </p>
        )}
        {existing && <p className="text-sm text-muted-foreground">{live ? "This offer is on. Shoppers get your changes on their next cart once you update it." : "This offer is off. Shoppers don't get it until you turn it on."}</p>}

        {existing?.previous && previousSentence && (
          <Section
            title="Before your last change"
            description={existing.previous.replaced_at ? `Changed ${whenIn(existing.previous.replaced_at, tz)}` : undefined}
            actions={
              <RoleGate role={role} action="offers.write" mode="hide" reason={NO_WRITE}>
                <Button type="button" size="sm" variant="outline" onClick={() => setAsk("revert")}>
                  <RotateCcw aria-hidden /> Go back to previous settings
                </Button>
              </RoleGate>
            }
          >
            <p className="text-sm text-foreground" data-sentence="previous">
              {previousSentence}
            </p>
            <p className="text-xs text-muted-foreground">{scheduleText(existing.previous.starts_at, existing.previous.ends_at, tz)}</p>
          </Section>
        )}

        <Section title="What kind of offer?">
          <OfferKindPicker type={form.type} fixed={!!existing || ro} onChange={(type) => set({ type })} />
        </Section>

        {form.type && (
          <Section title="The rules">
            <fieldset disabled={ro} className="space-y-4">
              {(form.type === "BXGY" || form.type === "TIERED_QTY") && (
                <TargetField
                  form={form}
                  set={set}
                  disabled={ro}
                  targetLabel={targetLabel}
                  onPicked={(value, label) => setPicked((p) => ({ ...p, [value]: label }))}
                  options={targetOptions}
                  optionsError={optionsError}
                  onRetry={loadTargetOptions}
                />
              )}
              {(form.type === "FREE_GIFT" || form.type === "COUPON") && <WholeCart />}

              {form.type === "BXGY" && (
                <div className="grid grid-cols-2 gap-3">
                  <Field id="offer-buy" label="Shopper buys">
                    <Input disabled={ro} id="offer-buy" type="number" min="1" step="1" inputMode="numeric" value={form.buy} onChange={(e) => set({ buy: e.target.value })} />
                  </Field>
                  <Field id="offer-free" label="And gets free">
                    <Input disabled={ro} id="offer-free" type="number" min="1" step="1" inputMode="numeric" value={form.free} onChange={(e) => set({ free: e.target.value })} />
                  </Field>
                </div>
              )}

              {form.type === "TIERED_QTY" && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">Steps</p>
                  {form.tiers.map((tier, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2 text-sm text-foreground" data-tier={i}>
                      <span>Buy</span>
                      <Input disabled={ro} type="number" min="1" step="1" inputMode="numeric" className="w-20" aria-label={`Step ${i + 1}: how many to buy`} value={tier.minQty} onChange={(e) => setTier(i, { minQty: e.target.value })} />
                      <span>or more, get</span>
                      <Input disabled={ro} type="number" min="1" max="90" inputMode="decimal" className="w-20" aria-label={`Step ${i + 1}: percent off`} value={tier.percent} onChange={(e) => setTier(i, { percent: e.target.value })} />
                      <span>% off</span>
                      {form.tiers.length > 1 && !ro && (
                        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove step ${i + 1}`} onClick={() => set({ tiers: form.tiers.filter((_, j) => j !== i) })}>
                          <X aria-hidden />
                        </Button>
                      )}
                    </div>
                  ))}
                  {!ro && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const last = form.tiers[form.tiers.length - 1];
                        set({ tiers: [...form.tiers, { minQty: String((Number(last?.minQty) || 1) + 1), percent: String(Math.min(90, (Number(last?.percent) || 5) + 5)) }] });
                      }}
                    >
                      <Plus aria-hidden /> Add a step
                    </Button>
                  )}
                </div>
              )}

              {form.type === "FREE_GIFT" && (
                <>
                  <Field id="offer-threshold" label={`Cart total over (${sign})`} hint="Counted before any discounts.">
                    <Input disabled={ro} id="offer-threshold" type="number" min="1" inputMode="decimal" value={form.threshold} onChange={(e) => set({ threshold: e.target.value })} />
                  </Field>
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium text-foreground">The free gift</p>
                    <div className="flex flex-wrap items-center gap-3">
                      <span className={form.gift?.title ? "text-sm font-medium text-foreground" : "text-sm text-muted-foreground"} data-picked="gift">
                        {form.gift?.title || "Nothing chosen yet"}
                      </span>
                      <RefCombobox
                        label="The free gift"
                        buttonText={form.gift ? "Change" : "Choose the gift"}
                        disabled={ro}
                        selectedId={form.gift?.variantId || null}
                        load={loadVariants}
                        onPick={(o) => set({ gift: { variantId: o.id, productId: o.product?.id, handle: o.product?.handle, title: o.label, value: o.variant?.price ?? o.product?.price_min ?? 0, image: o.variant?.thumb || o.product?.thumb || "" } })}
                      />
                    </div>
                  </div>
                  {form.gift && (
                    <Field id="offer-gift-value" label={`Gift is worth (${sign})`} hint="Shown crossed out next to the gift. We filled in its price.">
                      <Input disabled={ro} id="offer-gift-value" type="number" min="0" inputMode="decimal" value={str(form.gift.value)} onChange={(e) => set({ gift: { ...form.gift, value: e.target.value } })} />
                    </Field>
                  )}
                </>
              )}

              {form.type === "COUPON" && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field id="offer-code" label="Code shoppers type" hint={form.codeAuto ? "We suggested one. Change it if you like." : "3 to 20 letters or numbers."}>
                      <Input disabled={ro} id="offer-code" maxLength={20} autoCapitalize="characters" value={form.code} onChange={(e) => set({ code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} />
                    </Field>
                    <Field id="offer-disc-value" label="Discount">
                      <div className="flex gap-2">
                        <Select value={form.discKind} onValueChange={(v) => set({ discKind: v })} disabled={ro}>
                          <SelectTrigger aria-label="Kind of discount" className="w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="percent">% off</SelectItem>
                            <SelectItem value="fixed">{sign} off</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input disabled={ro} id="offer-disc-value" type="number" min="1" inputMode="decimal" value={form.discValue} onChange={(e) => set({ discValue: e.target.value })} />
                      </div>
                    </Field>
                  </div>
                  <div className="grid items-end gap-3 sm:grid-cols-2">
                    <Field id="offer-min-subtotal" label={`Minimum order (${sign}, optional)`}>
                      <Input disabled={ro} id="offer-min-subtotal" type="number" min="0" inputMode="decimal" value={form.minSubtotal} onChange={(e) => set({ minSubtotal: e.target.value })} />
                    </Field>
                    <label className="flex items-center gap-2 pb-2 text-sm text-foreground">
                      <Switch checked={form.combinable} disabled={ro} onCheckedChange={(v) => set({ combinable: v })} aria-label="Works with other offers" />
                      Works with other offers
                    </label>
                  </div>
                </>
              )}
            </fieldset>
          </Section>
        )}

        {form.type && (
          <Section title="What shoppers see, and when">
            <fieldset disabled={ro} className="space-y-4">
              <Field id="offer-title" label="Name in the cart (optional)" hint={!form.title.trim() && offer?.title ? `Leave it blank to use “${offer.title}”. It changes when the rules do.` : undefined}>
                <Input disabled={ro} id="offer-title" value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder={(offer && defaultOfferTitle(offer, say)) || "Filled in for you"} />
              </Field>
              <ScheduleField startsAt={form.startsAt} endsAt={form.endsAt} tz={tz} disabled={ro} onChange={set} />
            </fieldset>
          </Section>
        )}

        {form.type && (
          <Section title={ro ? "What shoppers get" : existing ? "Check before you update" : "Check before you start"}>
            {existing ? (
              <div className="grid gap-3 sm:grid-cols-2" data-compare="sentences">
                <div className="rounded-md border border-border p-3">
                  <p className="text-xs font-medium text-muted-foreground">{live ? "Live now" : "Saved now"}</p>
                  <p className="mt-1 text-sm text-foreground" data-sentence="old">
                    {oldSentence}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{scheduleText(existing.starts_at, existing.ends_at, tz)}</p>
                </div>
                <div className={cn("rounded-md border p-3", changed ? "border-primary" : "border-border")}>
                  <p className="text-xs font-medium text-muted-foreground">{live ? "After you update" : "After you save"}</p>
                  <p className="mt-1 text-sm font-medium text-foreground" data-sentence="new">
                    {sentence || "Finish the rules to see this."}
                  </p>
                  {offer?.title && <p className="mt-1 text-xs text-muted-foreground">Name in the cart: {offer.title}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">{changed ? scheduleText(schedule.startsAt, schedule.endsAt, tz) : "No changes yet."}</p>
                </div>
              </div>
            ) : (
              <p className={sentence ? "text-base font-semibold text-foreground" : "text-sm text-muted-foreground"} data-sentence="new">
                {sentence || "Finish the rules to see the offer in one sentence."}
              </p>
            )}
            {details.length > 0 && (
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}

            <SimulatePanel offer={offer && !problems.length ? offer : null} enabled={live} currency={currency} auto={dirty} onResult={setSim} />

            {warnings.length > 0 && (
              <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm" data-offer-warnings>
                <p className="font-medium text-warning-text">Check this is right</p>
                <ul className="mt-1 space-y-0.5 text-foreground">
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            {!ro && problems.length > 0 && (
              <div className="rounded-md border border-border bg-muted px-3 py-2" data-offer-problems>
                <p className="text-xs font-medium text-muted-foreground">Still to do</p>
                <ul className="mt-1 space-y-0.5 text-sm text-foreground">
                  {problems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
          </Section>
        )}

        {errors && (
          <div role="alert" className="rounded-card border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" data-offer-errors>
            <p className="font-medium">The offer didn&rsquo;t save</p>
            <ul className={cn("mt-1 space-y-0.5", errors.length > 1 && "list-disc pl-4")}>
              {errors.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {!existing && form.type && !problems.length && !ro && <p className="mr-auto text-xs text-muted-foreground">{schedule.startsAt ? `It goes live ${whenIn(schedule.startsAt, tz)}.` : "It goes live for shoppers straight away."}</p>}
          <Link href="/admin/offers" data-read-control className={buttonVariants({ variant: "outline" })}>
            {ro ? "Back to offers" : "Cancel"}
          </Link>
          {form.type && (
            <RoleGate role={role} action="offers.write" mode="hide" reason={NO_WRITE}>
              <Button type="button" disabled={busy || problems.length > 0 || Boolean(existing && !changed)} onClick={save} data-offer-save>
                {busy ? "Saving…" : primaryLabel}
              </Button>
            </RoleGate>
          )}
        </div>
      </div>

      {existing && canWrite && (
        <>
          <ConfirmAction
            open={ask === "off"}
            onOpenChange={(v) => !v && setAsk(null)}
            title="Turn off this offer?"
            destructive
            confirmLabel="Turn off"
            body={<p>Shoppers lose “{existing.label}” on their next cart. You can turn it back on at any time.</p>}
            onConfirm={() => setEnabled(false)}
          />
          <ConfirmAction
            open={ask === "delete"}
            onOpenChange={(v) => !v && setAsk(null)}
            title="Delete this offer?"
            destructive
            confirmLabel="Delete offer"
            body={<p>Delete “{existing.label}”? Shoppers lose it on their next cart, and it can&rsquo;t be brought back. To pause it instead, turn it off.</p>}
            onConfirm={async () => {
              await sendJson(`/api/admin/offers/${encodeURIComponent(id)}`, "DELETE");
              back(`Deleted “${existing.label}”.`);
            }}
          />
          {existing.previous && (
            <ConfirmAction
              open={ask === "revert"}
              onOpenChange={(v) => !v && setAsk(null)}
              title="Go back to previous settings?"
              confirmLabel="Go back"
              body={
                <>
                  <p>{!previousReach ? "Shoppers get this on their next cart:" : previousReach.why === "later" ? `Shoppers get this from ${whenIn(existing.previous.starts_at, tz)}:` : "Going back to:"}</p>
                  <p className="font-medium text-foreground">{previousSentence}</p>
                  {previousReach && previousReach.why !== "later" && (
                    <p className="text-warning-text">{previousReach.why === "ended" ? `Its dates ended ${whenIn(existing.previous.ends_at, tz)}, so shoppers won't get it after you go back. You can change the dates afterwards.` : "This offer is off, so shoppers won't get it until you turn it on."}</p>
                  )}
                  {dirty && <p className="text-warning-text">The changes you haven&rsquo;t saved here will be lost.</p>}
                  <p>Your saved settings are kept, so you can switch back the same way.</p>
                </>
              }
              onConfirm={async () => {
                const data = await sendJson(`/api/admin/offers/${encodeURIComponent(id)}/revert`, "POST", { expect: existing.previous?.replaced_at ?? null });
                back(doneMessage({ offer: data.offer, reverted: true }));
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
