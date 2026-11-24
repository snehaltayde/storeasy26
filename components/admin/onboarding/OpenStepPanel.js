"use client";

import { useState } from "react";
import Link from "next/link";
import { CircleAlert, CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/components/ui/utils";
import PolicyReader from "./PolicyReader";
import OpenStoreDialog from "./OpenStoreDialog";

// Onboarding step 4, "Open your store" (Phase 1 line 7). Renders what
// lib/onboarding/open-step.js says: every opening item with its own fixes,
// each already gated for the role (a control the role can't use is shown
// disabled with the reason under it, never refused after a click), then
// "Open your store", which opens OpenStoreDialog (the editor's own publish
// flow). After anything here saves, onChange() re-reads the steps.
//   cod_on        PUT /api/admin/settings { commerce: { checkout_mode: "direct" } }
//   contact_form  PUT /api/admin/settings { identity: { support_email, support_phone } }
//                 (shown only while both are empty: the save writes both)
//   policy_start  POST /api/admin/policy-start { kind }
//   policy_read   PolicyReader; "I've read it" POSTs { markRead }
//   test_order    POST /api/admin/onboarding { step: "test_order", done }
// Payment keys are never taken here: "Add Razorpay keys" is a link to Settings.

export const SETTINGS_URL = "/api/admin/settings";
export const POLICY_START_URL = "/api/admin/policy-start";
export const ONBOARDING_URL = "/api/admin/onboarding";

export const OPEN_PANEL_WORDS = Object.freeze({
  needed: "Needed",
  check: "Worth checking",
  notLegalAdvice: "These are starting points, not legal advice.",
  failed: "That didn't work, so nothing changed. Try again in a minute.",
  notAllowed: "Your role can't do that, so nothing changed.",
  checkoutOn: "Checkout is on. Shoppers can pay cash on delivery.",
  contactSaved: "Saved. Shoppers can reach you now.",
  contactEmail: "Support email",
  contactPhone: "Support phone",
  contactSave: "Save contact details",
  contactNeedOne: "Add an email or a phone number.",
  testOrderMarked: "You told us you placed a test order.",
  testOrderMark: "I placed a test order",
  testOrderUndo: "I haven't placed one yet",
  openTitle: "Open your store",
  openLead: "Opening publishes your home page, and anything it needs, so shoppers can visit. Other drafts stay drafts.",
  openButton: "Open your store",
  doneTitle: "Your store is open",
  doneWords: "Shoppers can visit your store. Changes you make show to them after you publish.",
  visit: "Visit your store",
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A console request. Never throws: { ok, status, body }.
export async function send(url, method, body) {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) || {};
    return { ok: res.ok && json.ok !== false, status: res.status, body: json };
  } catch {
    return { ok: false, status: 0, body: {} };
  }
}
const errorWords = (r) => {
  if (Array.isArray(r.body?.errors) && r.body.errors.length) return `${r.body.errors.join(". ")}.`;
  if (typeof r.body?.error === "string" && r.body.error && r.body.error !== "Unauthorized") return r.body.error;
  return r.status === 403 ? OPEN_PANEL_WORDS.notAllowed : OPEN_PANEL_WORDS.failed;
};

export function Notice({ tone = "danger", children }) {
  const Icon = tone === "success" ? CircleCheck : CircleAlert;
  return (
    <p role={tone === "danger" ? "alert" : "status"} className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-sm", tone === "danger" ? "bg-danger/10 text-danger" : "bg-success/10 text-success")}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

// A gated control: a button, or a link when href is given. Not allowed:
// disabled, with the reason under it (read with the control).
export function Control({ gate, href, reasonId, children, onClick, ...props }) {
  if (gate.allowed) {
    if (href) {
      return (
        <Button asChild {...props}>
          <Link href={href}>{children}</Link>
        </Button>
      );
    }
    return (
      <Button onClick={onClick} {...props}>
        {children}
      </Button>
    );
  }
  return (
    <span className="inline-flex flex-col items-start gap-1" data-onboarding="gated">
      <Button {...props} disabled aria-describedby={reasonId}>
        {children}
      </Button>
      <span id={reasonId} className="text-xs text-muted-foreground" data-onboarding="reason">
        {gate.reason}
      </span>
    </span>
  );
}

function ContactForm({ fix, busy, onSave }) {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [missing, setMissing] = useState(false);
  const disabled = !fix.allowed || busy;
  function submit(e) {
    e.preventDefault();
    if (!email.trim() && !phone.trim()) return setMissing(true);
    setMissing(false);
    onSave({ support_email: email.trim(), support_phone: phone.trim() });
  }
  return (
    <form onSubmit={submit} className="w-full space-y-3" data-onboarding="contact-form" noValidate>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-[0.8125rem] font-medium text-foreground">
          <span>{OPEN_PANEL_WORDS.contactEmail}</span>
          <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!fix.allowed} aria-invalid={missing || undefined} />
        </label>
        <label className="space-y-1 text-[0.8125rem] font-medium text-foreground">
          <span>{OPEN_PANEL_WORDS.contactPhone}</span>
          <Input type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!fix.allowed} aria-invalid={missing || undefined} />
        </label>
      </div>
      {missing && <p className="text-xs text-danger">{OPEN_PANEL_WORDS.contactNeedOne}</p>}
      <Control gate={fix} reasonId="contact-reason" type="submit" size="sm" variant="outline" disabled={disabled} aria-busy={busy || undefined}>
        {OPEN_PANEL_WORDS.contactSave}
      </Control>
    </form>
  );
}

function Fix({ fix, item, busy, run, onRead, onGoStep }) {
  const id = `reason-${item.id}-${fix.kind}`;
  const off = busy !== null;
  switch (fix.kind) {
    case "link":
      return (
        <Control gate={fix} href={fix.href} reasonId={id} size="sm" variant="outline">
          {fix.label}
        </Control>
      );
    case "cod_on":
      return (
        <Control gate={fix} reasonId={id} size="sm" disabled={off} aria-busy={busy === "cod_on" || undefined} onClick={() => run("cod_on", () => send(SETTINGS_URL, "PUT", { commerce: { checkout_mode: "direct" } }), OPEN_PANEL_WORDS.checkoutOn)}>
          {fix.label}
        </Control>
      );
    case "policy_start":
      return (
        <Control gate={fix} reasonId={id} size="sm" disabled={off} aria-busy={busy === item.id || undefined} onClick={() => run(item.id, () => send(POLICY_START_URL, "POST", { kind: fix.policyKind }))}>
          {fix.label}
        </Control>
      );
    case "policy_read":
      return (
        <Control gate={fix} reasonId={id} size="sm" disabled={off} onClick={() => onRead({ fix, title: item.title })}>
          {fix.label}
        </Control>
      );
    case "contact_form":
      return <ContactForm fix={fix} busy={busy === "contact"} onSave={(identity) => run("contact", () => send(SETTINGS_URL, "PUT", { identity }), OPEN_PANEL_WORDS.contactSaved)} />;
    case "test_order":
      return (
        <Control gate={fix} reasonId={id} size="sm" variant={fix.marked ? "ghost" : "outline"} disabled={off} aria-busy={busy === "test_order" || undefined} onClick={() => run("test_order", () => send(ONBOARDING_URL, "POST", { step: "test_order", done: !fix.marked }))}>
          {fix.marked ? OPEN_PANEL_WORDS.testOrderUndo : OPEN_PANEL_WORDS.testOrderMark}
        </Control>
      );
    case "step":
      return (
        <Button size="sm" onClick={() => onGoStep?.(fix.step)}>
          {fix.label}
        </Button>
      );
    case "support":
      return <p className="text-xs text-muted-foreground">{fix.label}</p>;
    default:
      return null;
  }
}

function Item({ item, ...rest }) {
  const fixes = item.fixes || [];
  const marked = fixes.find((f) => f.kind === "test_order")?.marked === true;
  const done = item.level === "ok";
  return (
    <li className="space-y-2 py-3" data-opening-item={item.id} data-level={item.level}>
      <div className="flex items-start gap-2">
        {done && <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />}
        <p className="min-w-0 flex-1 text-sm font-medium text-foreground">{item.title}</p>
        {item.level === "block" && <span className="shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">{OPEN_PANEL_WORDS.needed}</span>}
        {item.level === "warn" && <span className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-text">{OPEN_PANEL_WORDS.check}</span>}
      </div>
      {item.message && <p className="text-[0.8125rem] text-muted-foreground">{item.message}</p>}
      {marked && <p className="text-[0.8125rem] text-success">{OPEN_PANEL_WORDS.testOrderMarked}</p>}
      {fixes.length > 0 && (
        <div className="flex flex-wrap items-start gap-2">
          {fixes.map((f, i) => (
            <Fix key={`${f.kind}-${i}`} fix={f} item={item} {...rest} />
          ))}
        </div>
      )}
      {item.legalNote && <p className="text-xs text-muted-foreground">{OPEN_PANEL_WORDS.notLegalAdvice}</p>}
    </li>
  );
}

function Done({ facts }) {
  return (
    <section className="space-y-2" data-onboarding="open-done" aria-label={OPEN_PANEL_WORDS.doneTitle}>
      <p className="flex items-center gap-2 text-base font-medium text-foreground">
        <CircleCheck aria-hidden className="size-5 text-success" />
        {OPEN_PANEL_WORDS.doneTitle}
      </p>
      <p className="text-sm text-muted-foreground">{OPEN_PANEL_WORDS.doneWords}</p>
      {facts?.liveUrl && (
        <p className="text-sm">
          <a href={facts.liveUrl} data-onboarding="live-link" className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [overflow-wrap:anywhere]">
            {facts.storeAddress || OPEN_PANEL_WORDS.visit}
          </a>
        </p>
      )}
    </section>
  );
}

export default function OpenStepPanel({ step, onChange, onModel, onGoStep }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [reading, setReading] = useState(null);
  const [dialog, setDialog] = useState(false);
  const [opened, setOpened] = useState(false);

  if (step.state === "done") return <Done facts={step.facts} />;
  if (opened) return <Done facts={{ liveUrl: null }} />;

  async function run(key, request, okWords = null) {
    setBusy(key);
    setError(null);
    setNote(null);
    const r = await request();
    if (r.ok) {
      setNote(okWords || (typeof r.body?.message === "string" && r.body.message) || null);
      if (isObj(r.body) && Array.isArray(r.body.steps)) onModel?.(r.body);
      else await onChange?.();
    } else {
      setError(errorWords(r));
      if (r.status === 409) await onChange?.();
    }
    setBusy(null);
    return r;
  }

  const items = step.facts?.items || [];
  const open = step.actions?.find((a) => a.id === "open_store") || { allowed: false, reason: step.problem || OPEN_PANEL_WORDS.failed };
  return (
    <div className="space-y-4">
      {error && <Notice>{error}</Notice>}
      {note && <Notice tone="success">{note}</Notice>}
      {items.length > 0 && (
        <ul className="-mt-3 divide-y divide-border border-b border-border" data-onboarding="opening-items">
          {items.map((i) => (
            <Item key={i.id} item={i} busy={busy} run={run} onRead={setReading} onGoStep={onGoStep} />
          ))}
        </ul>
      )}

      <section className="space-y-3" data-onboarding="open-store" aria-label={OPEN_PANEL_WORDS.openTitle}>
        <p className="text-sm text-muted-foreground">{OPEN_PANEL_WORDS.openLead}</p>
        <Control gate={open} reasonId="open-reason" size="lg" className="h-10 px-4" disabled={busy !== null} onClick={() => setDialog(true)}>
          {OPEN_PANEL_WORDS.openButton}
        </Control>
      </section>

      <PolicyReader
        reading={reading}
        onClose={() => setReading(null)}
        onMarkRead={async (id, revision) => {
          const r = await run(`read:${id}`, () => send(POLICY_START_URL, "POST", { markRead: { id, revision } }));
          if (r.ok) setReading(null);
          return r;
        }}
        busy={busy !== null}
      />
      {open.allowed && (
        <OpenStoreDialog
          open={dialog}
          onOpenChange={setDialog}
          onOpened={() => {
            setDialog(false);
            setOpened(true);
            onChange?.();
          }}
          onChange={onChange}
        />
      )}
    </div>
  );
}
