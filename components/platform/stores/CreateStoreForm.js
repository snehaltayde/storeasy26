"use client";

// Phase 1 line 9: the operator's "New store" form. One column of fields with
// debounced live checks (address, Shopify store, existing account); Create
// store queues the setup and puts ?signup=sgn_… in the URL, so a reload shows
// the same progress (CreateStoreProgress). A refused submit keeps everything
// typed and moves focus to the first field with an error.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import CreateStoreProgress from "./CreateStoreProgress";
import { LABELS, slugPreview, firstErrorField } from "./createStoreWords";

const EMPTY = { storeName: "", email: "", founderName: "", shop: "", slug: "", clientId: "", clientSecret: "" };
const DEBOUNCE_MS = 400;

function Hint({ id, children, tone = "muted" }) {
  if (!children) return null;
  const cls = tone === "danger" ? "text-destructive" : tone === "success" ? "text-success" : tone === "info" ? "text-info" : "text-muted-foreground";
  return (
    <p id={id} className={`mt-1 text-xs ${cls}`}>
      {children}
    </p>
  );
}

function FieldRow({ id, label, hint, error, check, children }) {
  return (
    <div>
      <Label htmlFor={id} className="text-[0.8125rem] font-medium">
        {label}
      </Label>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <Hint id={`${id}-msg`} tone="danger">
          {error}
        </Hint>
      ) : check ? (
        <Hint id={`${id}-msg`} tone={check.tone}>
          {check.words}
        </Hint>
      ) : (
        <Hint id={`${id}-msg`}>{hint}</Hint>
      )}
    </div>
  );
}

export default function CreateStoreForm({ storeDomain }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const signup = sp.get("signup");
  const [f, setF] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [checks, setChecks] = useState({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const refs = useRef({});
  const timers = useRef({});
  const seq = useRef({});

  const slug = (f.slug.trim().toLowerCase() || slugPreview(f.storeName)).slice(0, 40);

  const runCheck = useCallback((key, param, value) => {
    clearTimeout(timers.current[key]);
    if (!value) {
      setChecks((c) => ({ ...c, [key]: null }));
      return;
    }
    setChecks((c) => ({ ...c, [key]: { tone: "muted", words: LABELS.checking } }));
    timers.current[key] = setTimeout(async () => {
      const id = (seq.current[key] = (seq.current[key] || 0) + 1);
      try {
        const res = await fetch(`/api/platform/stores?check=1&${param}=${encodeURIComponent(value)}`, { cache: "no-store" });
        if (res.status === 401) return window.location.assign("/platform");
        const body = await res.json().catch(() => null);
        if (id !== seq.current[key]) return;
        const r = body?.[key];
        if (!res.ok || !r) return setChecks((c) => ({ ...c, [key]: null }));
        let shown = null;
        if (key === "slug") shown = r.ok ? { tone: "success", words: `${LABELS.available}: ${r.host}` } : { tone: "danger", words: r.words };
        if (key === "shop") shown = r.ok ? { tone: "success", words: `${LABELS.available}: ${r.shop}` } : { tone: "danger", words: r.words };
        if (key === "email") shown = r.existingAccount ? { tone: "info", words: r.words } : null;
        setChecks((c) => ({ ...c, [key]: shown }));
      } catch {
        if (id === seq.current[key]) setChecks((c) => ({ ...c, [key]: null }));
      }
    }, DEBOUNCE_MS);
  }, []);

  useEffect(() => runCheck("slug", "slug", slug.length >= 2 ? slug : ""), [slug, runCheck]);
  useEffect(() => runCheck("shop", "shop", f.shop.trim()), [f.shop, runCheck]);
  useEffect(() => runCheck("email", "email", /@.+\./.test(f.email) ? f.email.trim() : ""), [f.email, runCheck]);
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);

  const set = (k) => (e) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    if (errors[k] || ((k === "clientId" || k === "clientSecret") && errors.app)) setErrors((x) => ({ ...x, [k]: undefined, ...(k.startsWith("client") ? { app: undefined } : {}) }));
  };

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    let res;
    let body;
    try {
      res = await fetch("/api/platform/stores", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
      body = await res.json().catch(() => null);
    } catch {
      setBusy(false);
      return setFormError("We couldn't reach the server, and no store was created. Check your connection, then press Create store again.");
    }
    if (res.status === 401) return window.location.assign("/platform");
    if (res.ok && body?.signup) {
      router.replace(`${pathname}?signup=${body.signup}`, { scroll: false });
      return;
    }
    setBusy(false);
    if (body?.errors) {
      setErrors(body.errors);
      const k = firstErrorField(body.errors);
      const target = k === "app" ? "clientId" : k;
      if (target) refs.current[target]?.focus();
      return;
    }
    setFormError(body?.error || "That didn't work, and no store was created. Press Create store to try again.");
  }

  if (signup) return <CreateStoreProgress signup={signup} />;

  const input = (k, props = {}) => (
    <Input
      id={`cs-${k}`}
      ref={(el) => (refs.current[k] = el)}
      value={f[k]}
      onChange={set(k)}
      aria-invalid={Boolean(errors[k] || (k.startsWith("client") && errors.app) || (checks[k]?.tone === "danger"))}
      aria-describedby={`cs-${k.startsWith("client") ? "app" : k}-msg`}
      {...props}
    />
  );

  return (
    <div className="mx-auto max-w-[640px] px-4 py-6 md:px-6">
      <a href="/platform" className="inline-flex items-center gap-1 rounded-md text-[0.8125rem] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <ArrowLeft className="size-3.5" aria-hidden /> {LABELS.back}
      </a>
      <h1 className="mt-2 text-[1.375rem] font-semibold">{LABELS.title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{LABELS.intro}</p>

      <form onSubmit={submit} noValidate className="mt-6 space-y-5 rounded-card border border-border bg-card p-4 shadow-card md:p-6">
        <FieldRow id="cs-storeName" label={LABELS.storeName} error={errors.storeName}>
          {input("storeName", { maxLength: 60, required: true, autoFocus: true, autoComplete: "off" })}
        </FieldRow>
        <FieldRow id="cs-email" label={LABELS.email} hint={LABELS.emailHint} error={errors.email} check={checks.email}>
          {input("email", { type: "email", required: true, autoComplete: "off", maxLength: 200 })}
        </FieldRow>
        <FieldRow id="cs-founderName" label={LABELS.founderName} hint={LABELS.founderNameHint} error={errors.founderName}>
          {input("founderName", { maxLength: 80, autoComplete: "off" })}
        </FieldRow>
        <FieldRow id="cs-shop" label={LABELS.shop} hint={LABELS.shopHint} error={errors.shop} check={checks.shop}>
          {input("shop", { required: true, placeholder: LABELS.shopPlaceholder, autoComplete: "off", spellCheck: false })}
        </FieldRow>
        <FieldRow id="cs-slug" label={LABELS.slug} hint={`${LABELS.slugHint}${slug ? ` ${slug}.${storeDomain}` : ""}`} error={errors.slug} check={checks.slug}>
          <div className="flex items-center gap-2">
            {input("slug", { placeholder: slugPreview(f.storeName) || "my-store", maxLength: 40, autoComplete: "off", spellCheck: false, className: "font-mono" })}
            <span className="shrink-0 truncate font-mono text-xs text-muted-foreground">.{storeDomain}</span>
          </div>
        </FieldRow>

        <Separator />
        <fieldset className="space-y-4">
          <legend className="text-sm font-medium">{LABELS.appTitle}</legend>
          <p className="-mt-2 text-xs text-muted-foreground">{LABELS.appHint}</p>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="cs-clientId" className="text-[0.8125rem] font-medium">
                {LABELS.clientId}
              </Label>
              <div className="mt-1.5">{input("clientId", { autoComplete: "off", spellCheck: false, maxLength: 200 })}</div>
            </div>
            <div>
              <Label htmlFor="cs-clientSecret" className="text-[0.8125rem] font-medium">
                {LABELS.clientSecret}
              </Label>
              <div className="mt-1.5">{input("clientSecret", { type: "password", autoComplete: "new-password", maxLength: 200 })}</div>
            </div>
          </div>
          <Hint id="cs-app-msg" tone="danger">
            {errors.app}
          </Hint>
        </fieldset>

        {formError && (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {formError}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Check className="size-4" aria-hidden />}
            {busy ? LABELS.submitting : LABELS.submit}
          </Button>
          <a href="/platform/onboarding" className="rounded-sm text-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            {LABELS.onboarding}
          </a>
        </div>
      </form>
    </div>
  );
}
