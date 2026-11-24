"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/components/ui/utils";
import { normalizeShopDomain } from "@/lib/shopify-origin";
import { CONNECT_WORDS, DENIED_HINT, connectErrorWords } from "@/lib/onboarding/connect-words";

// Phase 1 line 4: onboarding step 1. Owner and admin (connect_shopify allowed)
// enter the shop's address and connect; everyone else sees the step read-only
// with Connect disabled and the model's reason (no shop domain in their facts).
//   not locked     the address field (?shop=x.myshopify.com fills it, never
//                  submits) and one primary button: Connect when the app is
//                  set up, else "Save address"; once saved and unchanged,
//                  Connect disabled with "turns on here once it's ready"
//   locked         the address read-only with "Wrong store? Contact Storeasy
//                  support"; Connect (or Connect again) POSTs, then the browser
//                  goes to Shopify's approval page
//   ?connect_error=<code>  plain words for the code, read once; the parameter
//                  is then cleared from the address bar
// Nothing here talks to Shopify; /api/admin/shopify/connect does the checks.
export const CONNECT_URL = "/api/admin/shopify/connect";
// codes where nothing went wrong on the founder's side worth alarm: they
// stopped in Shopify or took too long; shown as a warning, not an error
const CALM_CODES = new Set(["denied", "expired"]);

function Notice({ tone = "danger", children }) {
  const Icon = tone === "success" ? CircleCheck : CircleAlert;
  return (
    <p role={tone === "danger" ? "alert" : "status"} className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-sm", tone === "danger" ? "bg-danger/10 text-danger" : tone === "warning" ? "bg-warning/10 text-warning-text" : "bg-success/10 text-success")}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function Disabled({ children, reason, reasonId }) {
  return (
    <span className="inline-flex flex-col items-start gap-1" data-onboarding="gated">
      <Button size="lg" className="h-10 px-4" disabled aria-describedby={reasonId}>
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
  const input = useRef(null);

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
    if (!n.ok) {
      setError(n.words);
      input.current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    const r = await postConnect({ shop: n.shop });
    setBusy(false);
    if (!r.ok) {
      setError(r.body?.error || connectErrorWords(r.body?.code));
      input.current?.focus();
      return;
    }
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
  // the saved address is unchanged while the app is prepared: the founder has
  // nothing to do, so the only control is Connect, disabled with the reason
  const waiting = !facts.appReady && Boolean(facts.shopDomain) && shop.trim() === facts.shopDomain;
  const errorId = `${ids}-error`;

  return (
    <div className="space-y-4" data-onboarding="connect">
      {flash && (
        <Notice tone={CALM_CODES.has(flash.code) ? "warning" : "danger"}>
          <span data-onboarding="connect-error" data-code={flash.code}>
            {connectErrorWords(flash.code)}
            {flash.code === "denied" ? ` ${DENIED_HINT}` : ""}
          </span>
        </Notice>
      )}

      {hasDomainFact && !showForm && (
        <dl className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 rounded-md border border-border bg-muted/50 px-3 py-2" data-onboarding="shop-domain">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{CONNECT_WORDS.shopLabel}</dt>
            <dd className="font-mono text-sm [overflow-wrap:anywhere]">{facts.shopDomain || <span className="font-sans text-muted-foreground">{CONNECT_WORDS.noDomain}</span>}</dd>
            {locked && !connected && (
              <dd className="mt-1 text-xs text-muted-foreground" data-onboarding="locked">
                {CONNECT_WORDS.locked}
              </dd>
            )}
          </div>
          {connected && facts.shopDomain && (
            <dd className="inline-flex items-center gap-1 text-xs font-medium text-success">
              <CircleCheck aria-hidden className="size-3.5" />
              {CONNECT_WORDS.connectedBadge}
            </dd>
          )}
        </dl>
      )}

      {showForm && (
        <form onSubmit={save} className="space-y-4" noValidate>
          <div className="space-y-2">
            <label htmlFor={`${ids}-shop`} className="block text-sm font-medium">
              {CONNECT_WORDS.shopLabel}
            </label>
            <Input
              ref={input}
              id={`${ids}-shop`}
              name="shop"
              value={shop}
              onChange={(e) => {
                setShop(e.target.value);
                if (error) setError(null);
              }}
              placeholder={CONNECT_WORDS.shopPlaceholder}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              inputMode="url"
              spellCheck={false}
              className="h-10 font-mono"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${errorId} ${ids}-hint` : `${ids}-hint`}
              data-onboarding="shop-input"
            />
            <p id={`${ids}-hint`} className="text-xs text-muted-foreground">
              {CONNECT_WORDS.shopHint}
            </p>
          </div>
          {error && (
            <div id={errorId}>
              <Notice>{error}</Notice>
            </div>
          )}
          {waiting ? (
            <Disabled reason={CONNECT_WORDS.preparingWait} reasonId={`${ids}-why`}>
              {label}
            </Disabled>
          ) : (
            <div className="space-y-2">
              <Button type="submit" size="lg" className="h-10 px-4" disabled={busy} aria-busy={busy || undefined} data-onboarding="shop-save">
                {busy && <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
                {facts.appReady ? label : CONNECT_WORDS.save}
              </Button>
              <p className="text-xs text-muted-foreground">{facts.appReady ? CONNECT_WORDS.connectHint : CONNECT_WORDS.preparingSave}</p>
            </div>
          )}
        </form>
      )}

      {canAct && locked && !connected && (
        <div className="space-y-4">
          {error && <Notice>{error}</Notice>}
          {facts.appReady ? (
            <div className="space-y-2">
              <Button size="lg" className="h-10 px-4" onClick={connect} disabled={busy} aria-busy={busy || undefined} data-onboarding="connect-button">
                {busy && <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
                {label}
              </Button>
              <p className="text-xs text-muted-foreground">{CONNECT_WORDS.connectHint}</p>
            </div>
          ) : (
            <Disabled reason={CONNECT_WORDS.preparingWait} reasonId={`${ids}-why`}>
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
