"use client";

import { useEffect, useId, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CircleAlert, CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/components/ui/utils";
import { normalizeShopDomain } from "@/lib/shopify-origin";
import { CONNECT_WORDS, DENIED_HINT, connectErrorWords } from "@/lib/onboarding/connect-words";

// Phase 1 line 4: onboarding step 1. Owner and admin (connect_shopify allowed)
// enter the shop's address and connect; everyone else sees the step read-only
// with Connect disabled and the model's reason (no shop domain in their facts).
//   not locked     the address field (?shop=x.myshopify.com fills it, never
//                  submits); "Save address" while the app isn't set up, with
//                  Connect disabled and "Storeasy's team is preparing…"
//   locked         the address read-only with "Wrong store? Contact Storeasy
//                  support"; Connect (or Connect again) POSTs, then the browser
//                  goes to Shopify's approval page
//   ?connect_error=<code>  plain words for the code, read once; the parameter
//                  is then cleared from the address bar
// Nothing here talks to Shopify; /api/admin/shopify/connect does the checks.
export const CONNECT_URL = "/api/admin/shopify/connect";

function Notice({ tone = "danger", children }) {
  const Icon = tone === "success" ? CircleCheck : CircleAlert;
  return (
    <p role={tone === "danger" ? "alert" : undefined} className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-sm", tone === "danger" ? "bg-danger/10 text-danger" : tone === "warning" ? "bg-warning/10 text-warning-text" : "bg-success/10 text-success")}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function Disabled({ children, reason, reasonId }) {
  return (
    <span className="inline-flex flex-col items-start gap-1" data-onboarding="gated">
      <Button disabled aria-describedby={reasonId}>
        {children}
      </Button>
      <span id={reasonId} className="text-xs text-muted-foreground" data-onboarding="reason">
        {reason}
      </span>
    </span>
  );
}

// Shown once on step 2 after Shopify sends the founder back (?connected=1);
// the parameter is then cleared, so a reload doesn't show it again.
export function ConnectedNote() {
  const params = useSearchParams();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (params?.get("connected") !== "1") return;
    setShown(true);
    const url = new URL(window.location.href);
    url.searchParams.delete("connected");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [params]);
  if (!shown) return null;
  return (
    <Notice tone="success">
      <span data-onboarding="connected-note">{CONNECT_WORDS.connectedNote}</span>
    </Notice>
  );
}

async function postConnect(body) {
  try {
    const res = await fetch(CONNECT_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) || {};
    return { ok: res.ok && json.ok !== false, status: res.status, body: json };
  } catch {
    return { ok: false, status: 0, body: {} };
  }
}

export function ConnectPanel({ step, onModel, onChange }) {
  const params = useSearchParams();
  const facts = step.facts || {};
  const action = step.actions?.find((a) => a.id === "connect_shopify") || null;
  const canAct = Boolean(action?.allowed);
  const hasDomainFact = Object.hasOwn(facts, "shopDomain");
  const [shop, setShop] = useState(() => facts.shopDomain || params?.get("shop") || "");
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null); // { code } from ?connect_error, read once
  const [busy, setBusy] = useState(false);
  const ids = useId();

  useEffect(() => {
    const code = params?.get("connect_error");
    if (!code) return;
    setFlash({ code });
    const url = new URL(window.location.href);
    url.searchParams.delete("connect_error");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [params]);

  useEffect(() => {
    if (facts.shopDomain) setShop(facts.shopDomain);
  }, [facts.shopDomain]);

  // done (a token, or products already in) and nothing to fix: no controls
  const connected = step.state === "done" && !facts.reconnect;
  const locked = facts.locked === true;
  const showForm = canAct && !locked && !connected;

  async function save(e) {
    e?.preventDefault();
    const n = normalizeShopDomain(shop);
    if (!n.ok) return setError(n.words);
    setError(null);
    setBusy(true);
    const r = await postConnect({ shop: n.shop });
    setBusy(false);
    if (!r.ok) return setError(r.body?.error || connectErrorWords(r.body?.code));
    if (r.body.appReady && r.body.authorizeUrl) return window.location.assign(r.body.authorizeUrl);
    if (Array.isArray(r.body.steps)) onModel?.(r.body);
    else onChange?.();
  }

  async function connect() {
    setError(null);
    setFlash(null);
    setBusy(true);
    const r = await postConnect({});
    if (r.ok && r.body.authorizeUrl) return window.location.assign(r.body.authorizeUrl);
    setBusy(false);
    setError(r.body?.error || connectErrorWords(r.body?.code));
    if (r.ok && Array.isArray(r.body.steps)) onModel?.(r.body);
  }

  const label = facts.reconnect ? CONNECT_WORDS.reconnect : CONNECT_WORDS.connect;

  return (
    <div className="space-y-3" data-onboarding="connect">
      {flash && (
        <Notice>
          <span data-onboarding="connect-error" data-code={flash.code}>
            {connectErrorWords(flash.code)}
            {flash.code === "denied" ? ` ${DENIED_HINT}` : ""}
          </span>
        </Notice>
      )}

      {hasDomainFact && !showForm && (
        <dl className="rounded-md border border-border px-3 py-2 text-sm" data-onboarding="shop-domain">
          <dt className="text-xs text-muted-foreground">{CONNECT_WORDS.shopLabel}</dt>
          <dd className="font-mono [overflow-wrap:anywhere]">{facts.shopDomain || <span className="font-sans text-muted-foreground">No Shopify store recorded yet.</span>}</dd>
          {locked && <dd className="mt-1 font-sans text-xs text-muted-foreground" data-onboarding="locked">{CONNECT_WORDS.locked}</dd>}
        </dl>
      )}

      {showForm && (
        <form onSubmit={save} className="space-y-2" noValidate>
          <label htmlFor={`${ids}-shop`} className="block text-sm font-medium">
            {CONNECT_WORDS.shopLabel}
          </label>
          <Input id={`${ids}-shop`} name="shop" value={shop} onChange={(e) => setShop(e.target.value)} placeholder="my-shop.myshopify.com" autoComplete="off" spellCheck={false} aria-invalid={error ? true : undefined} aria-describedby={`${ids}-hint`} data-onboarding="shop-input" />
          <p id={`${ids}-hint`} className="text-xs text-muted-foreground">
            {CONNECT_WORDS.shopHint}
          </p>
          {error && <Notice>{error}</Notice>}
          <div className="flex flex-wrap items-start gap-3">
            <Button type="submit" variant={facts.appReady ? "default" : "outline"} disabled={busy} data-onboarding="shop-save">
              {facts.appReady ? label : CONNECT_WORDS.save}
            </Button>
            {!facts.appReady && (
              <Disabled reason={CONNECT_WORDS.appNotReady} reasonId={`${ids}-why`}>
                {label}
              </Disabled>
            )}
          </div>
        </form>
      )}

      {canAct && locked && !connected && (
        <div className="space-y-2">
          {error && <Notice>{error}</Notice>}
          {facts.appReady ? (
            <Button onClick={connect} disabled={busy} data-onboarding="connect-button">
              {label}
            </Button>
          ) : (
            <Disabled reason={CONNECT_WORDS.appNotReady} reasonId={`${ids}-why`}>
              {label}
            </Disabled>
          )}
        </div>
      )}

      {!canAct && action && !connected && (
        <Disabled reason={action.reason} reasonId={`${ids}-why`}>
          {label}
        </Disabled>
      )}
    </div>
  );
}
