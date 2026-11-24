"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/components/ui/utils";

// Self-serve signup (Phase 1 line 1), on the marketing host. Steps, each with
// data-signup="<step>" for the drill:
//   form     name, email, password, store name and the store address (derived
//            from the store name, editable; availability checked as you type).
//            Errors per field; a lost connection keeps everything typed and
//            offers Try again.
//   code     the 6-digit code we emailed; a wrong code gets the same words
//            every time; a new code at most once a minute (the countdown).
//   working  "Setting up your store…" while the code is checked and the store made
//   failed   what went wrong in plain words, and Try again (same signup, same run)
//   done     on the way to the new store's sign-in handoff
//   closed   signups were switched off meanwhile
// Talks only to /api/signup, /api/signup/verify and /api/signup/resend; the
// se_signup cookie (httpOnly) binds the code to this browser.
const OFFLINE = "We couldn't reach Storeasy. Check your connection, then try again.";
const SERVER = "Something went wrong on our side. Try again in a moment.";
// a code check that takes longer than this is the store being made
const WORKING_AFTER_MS = 1200;

async function post(url, body) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { status: 0, body: {} };
  }
}

function Field({ id, label, hint, error, children }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} data-field-error={id} className="text-[0.8125rem] text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[0.8125rem] text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const described = (id, error, hint) => (error ? `${id}-error` : hint ? `${id}-hint` : undefined);

export default function SignupFlow({ storeDomain, codeMinutes = 15, resendSeconds = 60 }) {
  const [step, setStep] = useState("form");
  const [fields, setFields] = useState({ name: "", email: "", password: "", storeName: "", slug: "" });
  const [slugTouched, setSlugTouched] = useState(false);
  const [check, setCheck] = useState(null); // { slug, available, message } for what is typed now
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null); // { text, retry }
  const [busy, setBusy] = useState(false);
  const [signup, setSignup] = useState(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState(null);
  const [resendIn, setResendIn] = useState(0);
  const [resendNote, setResendNote] = useState(null);
  const [failure, setFailure] = useState(null); // { text, canRetry }
  const [closedText, setClosedText] = useState(null);
  const codeRef = useRef(null);
  const headingRef = useRef(null);

  const set = (k) => (e) => {
    const v = e.target.value;
    setFields((f) => ({ ...f, [k]: v }));
    setErrors((x) => (x[k] ? { ...x, [k]: undefined } : x));
  };

  // the address: derived from the store name until the founder edits it
  const slug = slugTouched ? fields.slug : check?.slug || "";
  const query = slugTouched ? `slug=${encodeURIComponent(fields.slug.trim().toLowerCase())}` : `storeName=${encodeURIComponent(fields.storeName)}`;
  const empty = slugTouched ? !fields.slug.trim() : fields.storeName.trim().length < 2;
  useEffect(() => {
    if (step !== "form") return undefined;
    if (empty) {
      setCheck(null);
      return undefined;
    }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/signup?${query}`, { signal: ctl.signal });
        if (!res.ok) return;
        const b = await res.json();
        setCheck({ slug: b.slug || "", available: Boolean(b.available), message: b.message || null });
      } catch {
        // a check that fails says nothing; the submit checks again
      }
    }, 300);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [query, empty, step]);

  // the resend countdown
  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const t = setTimeout(() => setResendIn((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  // focus follows the step (keyboard and screen-reader users land on the new screen)
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    if (step === "code") codeRef.current?.focus();
    else headingRef.current?.focus();
  }, [step]);

  const closed = (body) => {
    setClosedText(body?.error || "Signups are closed right now.");
    setStep("closed");
  };

  const submit = async (e) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormError(null);
    const r = await post("/api/signup", { ...fields, slug: slugTouched ? fields.slug.trim().toLowerCase() : undefined });
    setBusy(false);
    if (r.status === 200 && r.body?.ok) {
      setErrors({});
      setSignup(r.body.signup);
      setCode("");
      setCodeError(null);
      setResendNote(null);
      setResendIn(resendSeconds);
      setStep("code");
    } else if (r.status === 422) {
      setErrors(r.body?.errors || {});
      setFormError({ text: r.body?.error || "Check the highlighted fields." });
    } else if (r.status === 403 && r.body?.code === "SIGNUPS_CLOSED") {
      closed(r.body);
    } else if (r.status === 429) {
      setFormError({ text: r.body?.error || "Too many tries from here. Wait a while, then try again." });
    } else {
      setFormError({ text: r.status === 0 ? OFFLINE : r.body?.error || SERVER, retry: true });
    }
  };

  // verify ({ code }) or resume ({ retry: true }): both can make the store
  const finish = async (body) => {
    if (busy) return;
    setBusy(true);
    setCodeError(null);
    let making = Boolean(body.retry);
    const slow = setTimeout(() => {
      making = true;
      setStep("working");
    }, body.retry ? 0 : WORKING_AFTER_MS);
    const r = await post("/api/signup/verify", body);
    clearTimeout(slow);
    setBusy(false);
    if (r.status === 200 && r.body?.status === "done" && r.body.redirect) {
      setStep("done");
      window.location.assign(r.body.redirect);
    } else if (r.status === 200) {
      setFailure({ text: r.body?.error || SERVER, canRetry: r.body?.canRetry !== false });
      setStep("failed");
    } else if (r.status === 403 && r.body?.code === "SIGNUPS_CLOSED") {
      closed(r.body);
    } else if (r.status === 0 || r.status >= 500) {
      // the store may be half made: resume it, never ask for the used code again
      if (making) {
        setFailure({ text: r.status === 0 ? OFFLINE : SERVER, canRetry: true });
        setStep("failed");
      } else {
        setStep("code");
        setCodeError(r.status === 0 ? OFFLINE : SERVER);
      }
    } else if (body.retry) {
      setFailure({ text: r.body?.error || SERVER, canRetry: false });
      setStep("failed");
    } else {
      setStep("code");
      setCodeError(r.body?.error || SERVER);
    }
  };

  const verify = (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setCodeError("Enter the 6-digit code from the email.");
      return;
    }
    finish({ code });
  };

  const resend = async () => {
    if (resendIn > 0 || busy) return;
    setResendNote(null);
    const r = await post("/api/signup/resend");
    if (r.status === 200 && r.body?.ok) {
      setResendIn(resendSeconds);
      setResendNote({ text: `We sent a new code to ${signup?.email}. Use the newest one.` });
    } else if (r.status === 403 && r.body?.code === "SIGNUPS_CLOSED") {
      closed(r.body);
    } else {
      if (r.body?.retry_after_seconds) setResendIn(Number(r.body.retry_after_seconds) || resendSeconds);
      setResendNote({ text: r.status === 0 ? OFFLINE : r.body?.error || SERVER, error: true });
    }
  };

  const heading = (text) => (
    <h1 ref={headingRef} tabIndex={-1} className="text-[1.75rem] leading-tight font-semibold outline-none">
      {text}
    </h1>
  );

  if (step === "closed") {
    return (
      <section data-signup="closed" className="space-y-3">
        {heading("Signups are closed right now")}
        <p className="text-muted-foreground">{closedText}</p>
        <a href="/contact" className="inline-block font-medium text-primary underline-offset-4 hover:underline">
          Tell us about your store
        </a>
      </section>
    );
  }

  if (step === "working" || step === "done") {
    return (
      <section data-signup={step} role="status" aria-live="polite" className="space-y-3">
        {heading(step === "done" ? "Opening your store…" : "Setting up your store…")}
        <p className="text-muted-foreground">
          {step === "done" ? "Your store is ready. Taking you there now." : `We're making ${signup?.storeName || "your store"} at ${signup?.address || "its new address"}. This takes a few seconds; keep this page open.`}
        </p>
        <div aria-hidden className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full w-1/3 rounded-full bg-primary motion-safe:animate-pulse" />
        </div>
      </section>
    );
  }

  if (step === "failed") {
    return (
      <section data-signup="failed" className="space-y-4">
        {heading("We couldn't finish setting up your store")}
        <p role="alert" className="text-muted-foreground">
          {failure?.text}
        </p>
        <div className="flex flex-wrap gap-2">
          {failure?.canRetry && (
            <Button size="lg" disabled={busy} onClick={() => finish({ retry: true })}>
              {busy ? "Trying again…" : "Try again"}
            </Button>
          )}
          {!failure?.canRetry && (
            <Button size="lg" variant="outline" onClick={() => setStep("form")}>
              Start again
            </Button>
          )}
        </div>
      </section>
    );
  }

  if (step === "code") {
    return (
      <section data-signup="code" className="space-y-6">
        <div className="space-y-2">
          {heading("Check your email")}
          <p className="text-muted-foreground">
            We sent a 6-digit code to <span className="font-medium text-foreground">{signup?.email}</span>. It works for {signup?.codeMinutes || codeMinutes} minutes.
          </p>
        </div>
        <form onSubmit={verify} noValidate className="space-y-4">
          <Field id="signup-code" label="Code from the email" error={codeError}>
            <Input
              ref={codeRef}
              id="signup-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => {
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                setCodeError(null);
              }}
              aria-invalid={codeError ? true : undefined}
              aria-describedby={described("signup-code", codeError)}
              className="h-10 max-w-48 font-mono text-lg tracking-[0.3em]"
            />
          </Field>
          <Button type="submit" size="lg" disabled={busy}>
            {busy ? "Checking your code…" : "Verify and create my store"}
          </Button>
        </form>
        <div className="space-y-2 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" disabled={resendIn > 0 || busy} onClick={resend} data-signup-resend>
              Send a new code
            </Button>
            {resendIn > 0 && (
              <p className="text-[0.8125rem] text-muted-foreground" data-signup-countdown aria-live="off">
                You can ask for a new code in {resendIn} s.
              </p>
            )}
          </div>
          {resendNote && (
            <p role="status" className={cn("text-[0.8125rem]", resendNote.error ? "text-destructive" : "text-muted-foreground")}>
              {resendNote.text}
            </p>
          )}
          <Button type="button" variant="link" className="h-auto px-0" onClick={() => setStep("form")}>
            Change your details or email
          </Button>
        </div>
      </section>
    );
  }

  const slugError = errors.slug || (check && !check.available && slug && check.slug === slug ? check.message : null);
  const address = slug ? `${slug}.${storeDomain}` : null;
  return (
    <section data-signup="form" className="space-y-6">
      <div className="space-y-2">
        {heading("Create your store")}
        <p className="text-muted-foreground">Your storefront, built from your Shopify products. We'll email you a code to confirm it's you; nothing is created until you type it.</p>
      </div>
      {formError && (
        <div role="alert" data-signup-error className="flex flex-wrap items-center gap-3 rounded-card border border-destructive/30 bg-destructive/5 p-3">
          <p className="min-w-0 flex-1 text-destructive">{formError.text}</p>
          {formError.retry && (
            <Button type="button" variant="outline" size="sm" onClick={submit} disabled={busy}>
              Try again
            </Button>
          )}
        </div>
      )}
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="signup-name" label="Your name" error={errors.name}>
            <Input id="signup-name" name="name" autoComplete="name" maxLength={80} value={fields.name} onChange={set("name")} aria-invalid={errors.name ? true : undefined} aria-describedby={described("signup-name", errors.name)} className="h-10" />
          </Field>
          <Field id="signup-email" label="Email" error={errors.email}>
            <Input id="signup-email" name="email" type="email" autoComplete="email" maxLength={200} value={fields.email} onChange={set("email")} aria-invalid={errors.email ? true : undefined} aria-describedby={described("signup-email", errors.email)} className="h-10" />
          </Field>
        </div>
        <Field id="signup-password" label="Password" hint="At least 8 characters, and not your email." error={errors.password}>
          <Input id="signup-password" name="password" type="password" autoComplete="new-password" maxLength={200} value={fields.password} onChange={set("password")} aria-invalid={errors.password ? true : undefined} aria-describedby={described("signup-password", errors.password, true)} className="h-10" />
        </Field>
        <Field id="signup-store" label="Store name" error={errors.storeName}>
          <Input id="signup-store" name="storeName" autoComplete="organization" maxLength={60} value={fields.storeName} onChange={set("storeName")} aria-invalid={errors.storeName ? true : undefined} aria-describedby={described("signup-store", errors.storeName)} className="h-10" />
        </Field>
        <Field id="signup-slug" label="Store address" hint={address ? (check?.available && check.slug === slug ? `${address} is free.` : `Your store will be at ${address}.`) : "Made from your store name. You can change it."} error={slugError}>
          <div className="flex items-center gap-2">
            <Input
              id="signup-slug"
              name="slug"
              autoComplete="off"
              spellCheck={false}
              maxLength={40}
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setFields((f) => ({ ...f, slug: e.target.value.toLowerCase() }));
                setErrors((x) => (x.slug ? { ...x, slug: undefined } : x));
              }}
              aria-invalid={slugError ? true : undefined}
              aria-describedby={described("signup-slug", slugError, true)}
              className="h-10 min-w-0 flex-1 font-mono"
            />
            <span className="shrink-0 font-mono text-muted-foreground">.{storeDomain}</span>
          </div>
        </Field>
        <Button type="submit" size="lg" disabled={busy} className="w-full md:w-auto">
          {busy ? "Sending your code…" : "Email me a code"}
        </Button>
      </form>
    </section>
  );
}
