"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { sendJson } from "@/components/admin/offers/ConfirmAction";

// Create or edit one automation rule in a sheet (Phase 2 line 9): when it
// runs (trigger and conditions), what it does (one email), how often (a
// daily cap) and when not (quiet hours, store time). lib/automations.js
// validates it again. Admins and owners only (settings.write): the page
// never renders this for anyone else.
//   open, onOpenChange, rule (to edit) | null, triggers, actions, onSaved()
export const TRIGGER_WORDS = { order_placed: "An order is placed", return_requested: "A return is asked for" };
export const ACTION_WORDS = { notify_merchant: "Email the store", email_customer: "Email the customer" };
const NEW = { name: "", trigger: "order_placed", min_total: "", payment_method: "", kind: "notify_merchant", subject: "", text: "", cap_per_day: 25, quiet_start: "", quiet_end: "", enabled: false };

const fromRule = (r) => ({
  name: r.name,
  trigger: r.trigger,
  min_total: r.conditions?.min_total ?? "",
  payment_method: r.conditions?.payment_method ?? "",
  kind: r.action?.kind || "notify_merchant",
  subject: r.action?.subject || "",
  text: r.action?.text || "",
  cap_per_day: r.cap_per_day,
  quiet_start: r.quiet_start || "",
  quiet_end: r.quiet_end || "",
  enabled: !!r.enabled,
});

export function ruleBody(f) {
  const conditions = {};
  if (String(f.min_total).trim() !== "") conditions.min_total = Number(f.min_total);
  if (f.payment_method) conditions.payment_method = f.payment_method;
  return {
    name: f.name,
    trigger: f.trigger,
    conditions,
    action: { kind: f.kind, subject: f.subject, text: f.text },
    cap_per_day: Number(f.cap_per_day),
    quiet_start: f.quiet_start || null,
    quiet_end: f.quiet_end || null,
  };
}

function Field({ id, label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-[0.8125rem] text-muted-foreground">{hint}</p>}
    </div>
  );
}
// Native selects (the phone's own picker, no portal) drawn like Input.
const SELECT = "h-8 w-full rounded-md border border-input bg-muted px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

export function RuleSheet({ open, onOpenChange, rule = null, triggers = Object.keys(TRIGGER_WORDS), actions = Object.keys(ACTION_WORDS), onSaved }) {
  const [f, setF] = useState(NEW);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setF(rule ? fromRule(rule) : NEW);
    setError(null);
  }, [open, rule]);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const missing = !f.name.trim() || !f.text.trim();

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await sendJson("/api/admin/automations", "POST", { automation: ruleBody(f), id: rule?.id || null, enabled: f.enabled });
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      setError(e.body?.errors?.length ? e.body.errors.join(". ") : e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !saving && onOpenChange(v)}>
      <SheetContent side="right" showCloseButton={false} className="overflow-y-auto p-4 data-[side=right]:w-full data-[side=right]:max-sm:rounded-none sm:p-6 data-[side=right]:sm:max-w-lg" data-automation="sheet">
        <SheetHeader className="flex-row items-start justify-between gap-2 p-0">
          <div>
            <SheetTitle>{rule ? "Edit rule" : "New rule"}</SheetTitle>
            <SheetDescription>One trigger, one email. The same order never sets a rule off twice.</SheetDescription>
          </div>
          <SheetClose asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Close">
              <X aria-hidden />
            </Button>
          </SheetClose>
        </SheetHeader>
        <div className="space-y-4">
          <Field id="aut-name" label="Name" hint="For you; customers never see it.">
            <Input id="aut-name" value={f.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field id="aut-trigger" label="When">
            <select id="aut-trigger" className={SELECT} value={f.trigger} onChange={(e) => set({ trigger: e.target.value })}>
              {triggers.map((k) => (
                <option key={k} value={k}>
                  {TRIGGER_WORDS[k] || k}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="aut-min" label="Only if the total is at least" hint="Leave empty for any total.">
              <Input id="aut-min" type="number" min="0" className="font-mono tabular-nums" value={f.min_total} onChange={(e) => set({ min_total: e.target.value })} />
            </Field>
            <Field id="aut-pay" label="Only if paid by">
              <select id="aut-pay" className={SELECT} value={f.payment_method} onChange={(e) => set({ payment_method: e.target.value })}>
                <option value="">Any way</option>
                <option value="razorpay">Online (Razorpay)</option>
                <option value="cod">Cash on delivery</option>
              </select>
            </Field>
          </div>
          <Field id="aut-kind" label="Then" hint={f.kind === "email_customer" ? "Sent only when the customer agreed to marketing emails at checkout, and only for a new order." : null}>
            <select id="aut-kind" className={SELECT} value={f.kind} onChange={(e) => set({ kind: e.target.value })}>
              {actions.map((k) => (
                <option key={k} value={k}>
                  {ACTION_WORDS[k] || k}
                </option>
              ))}
            </select>
          </Field>
          <Field id="aut-subject" label="Subject" hint="Leave empty for a plain default.">
            <Input id="aut-subject" value={f.subject} onChange={(e) => set({ subject: e.target.value })} />
          </Field>
          <Field id="aut-text" label="Message">
            <Textarea id="aut-text" value={f.text} onChange={(e) => set({ text: e.target.value })} />
          </Field>
          <Field id="aut-cap" label="At most this many a day">
            <Input id="aut-cap" type="number" min="1" max="500" className="max-w-32 font-mono tabular-nums" value={f.cap_per_day} onChange={(e) => set({ cap_per_day: e.target.value })} />
          </Field>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Quiet hours (store time)</legend>
            <div className="flex items-center gap-2">
              <Input aria-label="Quiet from" type="time" value={f.quiet_start} onChange={(e) => set({ quiet_start: e.target.value })} className="w-32 font-mono tabular-nums" />
              <span className="text-sm text-muted-foreground">to</span>
              <Input aria-label="Quiet until" type="time" value={f.quiet_end} onChange={(e) => set({ quiet_end: e.target.value })} className="w-32 font-mono tabular-nums" />
            </div>
            <p className="text-[0.8125rem] text-muted-foreground">Nothing is sent in this window; it is skipped, not saved for later. Leave both empty for none.</p>
          </fieldset>
          <div className="flex items-center gap-2 rounded-md border border-border p-3">
            <Checkbox id="aut-enabled" checked={f.enabled} onCheckedChange={(v) => set({ enabled: v === true })} />
            <Label htmlFor="aut-enabled">Turn it on after saving</Label>
          </div>
        </div>
        <SheetFooter className="sticky bottom-0 -mx-4 mt-auto -mb-4 gap-2 border-t border-border bg-popover px-4 py-3 sm:-mx-6 sm:-mb-6 sm:px-6 sm:py-4">
          {missing && <p className="text-[0.8125rem] text-muted-foreground">Give the rule a name and a message to save it.</p>}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="button" disabled={missing || saving} onClick={save}>
            {saving ? "Saving…" : "Save rule"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
