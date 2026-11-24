"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CircleAlert, CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { SyncProgressBody, readSync, requestSync, POLL_MS } from "@/components/admin/SyncProgress";
import FirstRun from "@/components/admin/first-run/FirstRun";

// The four onboarding step panels (Phase 1 line 3). Each shows what the step
// model (lib/onboarding/steps.js) says about the step and wires only what the
// console can do today; lines 4–7 rebuild each one. A control the role can't
// use is shown disabled with the model's reason under it (the RoleGate
// pattern), never hidden and never refused after a click. After anything here
// saves, onChange() re-reads the steps.
//   Connect  ./ConnectPanel (line 4): the address, Connect through Shopify's
//            approval, the errors; nothing is written to Shopify
//   Import   SyncProgress's own body, readSync and requestSync (/api/admin/sync)
//   Brand    FirstRun (the starter store and BrandStep at #brand), legacy styled
//   Open     the opening report's items, the policy starters
//            (/api/admin/policy-start), "I placed a test order"
//            (/api/admin/onboarding) and the way to the editor's Publish

export const POLICY_START_URL = "/api/admin/policy-start";
export const ONBOARDING_URL = "/api/admin/onboarding";
export const PANEL_WORDS = Object.freeze({
  notLegalAdvice: "These are starting points, not legal advice.",
  failed: "That didn't work, so nothing changed. Try again in a minute.",
  notAllowed: "Your role can't do that, so nothing changed.",
  shopDomain: "Your Shopify store",
  noDomain: "No Shopify store recorded yet.",
  products: (n) => (n === 1 ? "1 product is in your store." : `${n} products are in your store.`),
  testOrderTitle: "A test order",
  testOrderMarked: "You told us you placed a test order.",
  testOrderMark: "I placed a test order",
  testOrderUndo: "I haven't placed one yet",
  openTitle: "Open your store",
  openWords: "Opening happens in the editor: Publish your home page and your store opens to shoppers.",
  openButton: "Go to Publish in the editor",
  fixFirst: "Fix the items marked “Needed” first.",
  openDone: "Shoppers can visit your store. Changes you make show to them after you publish.",
  supportFixes: "Storeasy's team fixes this for you.",
  needed: "Needed",
  check: "Worth checking",
});

const actionOf = (step, id) => step.actions?.find((a) => a.id === id) || null;

async function post(url, body) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) || {};
    return { ok: res.ok && json.ok !== false, status: res.status, body: json };
  } catch {
    return { ok: false, status: 0, body: {} };
  }
}
const errorWords = (r) => (typeof r.body?.error === "string" && r.body.error ? r.body.error : r.status === 403 ? PANEL_WORDS.notAllowed : PANEL_WORDS.failed);

// A control the role may or may not use. Not allowed: disabled, with the
// reason under it (and read by screen readers with the button).
export function Gated({ action, children, reasonId, ...props }) {
  if (!action) return null;
  if (action.allowed) return <Button {...props}>{children}</Button>;
  return (
    <span className="inline-flex flex-col items-start gap-1" data-onboarding="gated">
      <Button {...props} disabled aria-describedby={reasonId} onClick={undefined}>
        {children}
      </Button>
      <span id={reasonId} className="text-xs text-muted-foreground" data-onboarding="reason">
        {action.reason}
      </span>
    </span>
  );
}

function Notice({ tone = "danger", children }) {
  const Icon = tone === "success" ? CircleCheck : CircleAlert;
  return (
    <p role={tone === "danger" ? "alert" : undefined} className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-sm", tone === "danger" ? "bg-danger/10 text-danger" : tone === "warning" ? "bg-warning/10 text-warning-text" : "bg-success/10 text-success")}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

// ---- Connect ---------------------------------------------------------------
// Phase 1 line 4: the panel lives in ./ConnectPanel (it reads ?shop and ?connect_error itself).
export { ConnectPanel } from "./ConnectPanel";

// ---- Import ----------------------------------------------------------------
const LIVE = new Set(["running", "retrying"]);

export function ImportPanel({ step, onChange, pollMs = POLL_MS }) {
  const [view, setView] = useState(step.facts?.sync || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const was = useRef(view?.state);
  // a fresh read of the steps brings a fresh sync view
  const fresh = JSON.stringify(step.facts?.sync || null);
  useEffect(() => setView(step.facts?.sync || null), [fresh]);

  useEffect(() => {
    if (view && view.state !== was.current) {
      const before = was.current;
      was.current = view.state;
      if (before && LIVE.has(before) !== LIVE.has(view.state)) onChange?.();
    }
    if (!view || !LIVE.has(view.state)) return undefined;
    const timer = setTimeout(async () => {
      const next = await readSync().catch(() => null);
      setView(next || ((v) => ({ ...v })));
    }, pollMs);
    return () => clearTimeout(timer);
  }, [view]);

  async function act(body) {
    setBusy(true);
    setError(null);
    const res = await requestSync(body);
    if (res.ok && res.sync) setView(res.sync);
    else if (!res.ok) setError(res.error);
    setBusy(false);
  }

  const syncAction = actionOf(step, "retry_sync") || actionOf(step, "start_sync");
  const blocked = step.state === "blocked";
  return (
    <div className="space-y-3">
      {step.state === "done" && typeof step.facts?.products === "number" && step.facts.products > 0 && <p className="text-sm text-foreground">{PANEL_WORDS.products(step.facts.products)}</p>}
      {view && !blocked && (
        <div data-legacy className="contents">
          <div data-onboarding="sync">
            <SyncProgressBody view={view} busy={busy} error={error} canRun={Boolean(syncAction?.allowed)} showStart={step.state === "done"} onRetry={() => act({ retry: true })} onStart={() => act({})} />
          </div>
        </div>
      )}
      {syncAction && !syncAction.allowed && !blocked && (
        <Gated action={syncAction} reasonId="import-reason" variant="outline">
          {syncAction.id === "retry_sync" ? "Try again" : view?.state === "none" || !view ? "Bring in products" : "Refresh from Shopify"}
        </Gated>
      )}
    </div>
  );
}

// ---- Brand -----------------------------------------------------------------
export function BrandPanel({ step, canSync, onChange }) {
  if (step.state === "blocked" || (step.problem && !step.actions?.length)) return null;
  const edit = actionOf(step, "brand_save");
  return (
    <div className="space-y-3">
      {edit && !edit.allowed && (
        <p className="text-xs text-muted-foreground" data-onboarding="reason">
          {edit.reason}
        </p>
      )}
      <div data-legacy className="contents">
        <div data-onboarding="brand">
          <FirstRun canEdit={Boolean(edit?.allowed)} canSync={canSync} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}

// ---- Open ------------------------------------------------------------------
const policyKey = (a) => (a.type === "startPolicy" ? `start:${a.kind}` : `read:${a.id}`);

function OpeningItem({ item, step, busy, onAct }) {
  const acts = Array.isArray(item.actions) ? item.actions : [];
  return (
    <li className="space-y-2 py-3" data-opening-item={item.id} data-level={item.level}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium text-foreground">{item.title}</p>
        {item.level === "block" && <span className="shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">{PANEL_WORDS.needed}</span>}
        {item.level === "warn" && <span className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-text">{PANEL_WORDS.check}</span>}
      </div>
      {item.message && <p className="text-[0.8125rem] text-muted-foreground">{item.message}</p>}
      {(acts.length > 0 || item.href || item.who === "support") && (
        <div className="flex flex-wrap items-start gap-2">
          {acts.map((a) => {
            const gate = actionOf(step, a.type === "startPolicy" ? "policy_start" : "policy_read");
            const key = policyKey(a);
            return (
              <Gated key={key} action={gate} reasonId={`reason-${key.replace(/\W/g, "-")}`} size="sm" variant={a.type === "startPolicy" ? "default" : "outline"} disabled={busy !== null} aria-busy={busy === key || undefined} onClick={() => onAct(a)}>
                {a.label}
              </Gated>
            );
          })}
          {item.href && (
            <Button asChild size="sm" variant="outline">
              <Link href={item.href}>{item.linkLabel || "Fix this"}</Link>
            </Button>
          )}
          {item.who === "support" && <p className="text-xs text-muted-foreground">{PANEL_WORDS.supportFixes}</p>}
        </div>
      )}
      {acts.length > 0 && <p className="text-xs text-muted-foreground">{PANEL_WORDS.notLegalAdvice}</p>}
    </li>
  );
}

export function OpenPanel({ step, publishHref, onChange, onModel }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  if (step.state === "done") return <p className="text-sm text-muted-foreground">{PANEL_WORDS.openDone}</p>;

  const items = (step.facts?.items || []).filter((i) => i.level !== "ok" && i.id !== "test_order");
  const testItem = (step.facts?.items || []).find((i) => i.id === "test_order");
  const marked = step.facts?.testOrderMarked === true;

  async function policy(a) {
    const key = policyKey(a);
    setBusy(key);
    setError(null);
    setNote(null);
    const r = await post(POLICY_START_URL, a.type === "startPolicy" ? { kind: a.kind } : { markRead: { id: a.id, revision: a.revision } });
    if (r.ok) setNote(r.body.message || (a.type === "markPolicyRead" ? "Marked as read. This page now counts as yours." : "Your page is started as a draft."));
    else setError(errorWords(r));
    if (r.ok || r.status === 409) await onChange?.();
    setBusy(null);
  }
  async function testOrder(done) {
    setBusy("test_order");
    setError(null);
    setNote(null);
    const r = await post(ONBOARDING_URL, { step: "test_order", done });
    if (r.ok && Array.isArray(r.body.steps)) onModel?.(r.body);
    else setError(errorWords(r));
    setBusy(null);
  }

  const testAction = actionOf(step, "test_order");
  const open = actionOf(step, "open_store");
  const blocked = step.state === "blocked";
  return (
    <div className="space-y-4">
      {error && <Notice>{error}</Notice>}
      {note && <Notice tone="success">{note}</Notice>}
      {items.length > 0 && (
        <ul className="-mt-3 divide-y divide-border border-b border-border" data-onboarding="opening-items">
          {items.map((i) => (
            <OpeningItem key={i.id} item={i} step={step} busy={busy} onAct={policy} />
          ))}
        </ul>
      )}

      <section className="space-y-2" data-onboarding="test-order" aria-label={PANEL_WORDS.testOrderTitle}>
        <p className="text-sm font-medium text-foreground">{PANEL_WORDS.testOrderTitle}</p>
        {marked ? (
          <p className="flex items-center gap-2 text-sm text-success"><CircleCheck aria-hidden className="size-4" />{PANEL_WORDS.testOrderMarked}</p>
        ) : (
          testItem?.message && <p className="text-[0.8125rem] text-muted-foreground">{testItem.message}</p>
        )}
        <div className="flex flex-wrap items-start gap-2">
          {!marked && testItem?.href && (
            <Button asChild size="sm" variant="outline">
              <Link href={testItem.href}>{testItem.linkLabel || "Open your preview"}</Link>
            </Button>
          )}
          <Gated action={testAction} reasonId="test-order-reason" size="sm" variant={marked ? "ghost" : "outline"} disabled={busy !== null} aria-busy={busy === "test_order" || undefined} onClick={() => testOrder(!marked)}>
            {marked ? PANEL_WORDS.testOrderUndo : PANEL_WORDS.testOrderMark}
          </Gated>
        </div>
      </section>

      {open && (
        <section className="space-y-3 border-t border-border pt-4" data-onboarding="open-store" aria-label={PANEL_WORDS.openTitle}>
          <p className="text-sm text-muted-foreground">{PANEL_WORDS.openWords}</p>
          {open.allowed && !blocked ? (
            <Button asChild size="lg" className="h-10 px-4">
              <Link href={publishHref}>
                {PANEL_WORDS.openButton}
              </Link>
            </Button>
          ) : (
            <Gated action={open.allowed ? { ...open, allowed: false, reason: PANEL_WORDS.fixFirst } : open} reasonId="open-reason" size="lg" className="h-10 px-4">
              {PANEL_WORDS.openButton}
            </Gated>
          )}
        </section>
      )}
    </div>
  );
}
