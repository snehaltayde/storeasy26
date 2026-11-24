"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Eye, EyeOff, Globe, LoaderCircle } from "lucide-react";
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
//   working  "Setting up your store…": the four steps (polled from
//            /api/signup/status every 1.5 s, slower while the tab is hidden)
//            and, when the hosting provider is slow, the retry note
//   failed   what went wrong in plain words (data-failure-kind:
//            retry_exhausted | needs_operator | lapsed), and Try again (same
//            signup, same job and run) or Start again
//   done     on the way to the new store's sign-in handoff (or its sign-in page)
//   closed   signups were switched off meanwhile
// Talks only to /api/signup, /api/signup/verify, /api/signup/status and
// /api/signup/resend; the se_signup cookie (httpOnly) binds them to this browser.
const OFFLINE = "We couldn't reach Storeasy. Check your connection, then try again.";
const SERVER = "Something went wrong on our side. Try again in a moment.";
const LOST = "We lost touch with Storeasy for a moment. Still checking…";
// how often the waiting page asks where setup stands; hidden tabs ask less often
const POLL_MS = 1500;
const POLL_HIDDEN_MS = 15_000;
// shown until the first status answer names them
const STEP_LABELS = ["Creating your store's database", "Preparing your store", "Registering your store address", "Creating your account"];
const INITIAL_STEPS = STEP_LABELS.map((label, i) => ({ label, state: i === 0 ? "working" : "waiting" }));

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
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} data-field-error={id} className="flex items-start gap-1.5 text-[0.8125rem] text-destructive">
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
      {hint && (!error || typeof hint !== "string") ? (
        <div id={`${id}-hint`} className="text-[0.8125rem] text-muted-foreground">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

// error first (it is what to fix), then the hint that stays on screen
const described = (id, error, hint) => [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(" ") || undefined;

// the order fields are checked in, for moving focus to the first one to fix
const FIELD_IDS = [
  ["name", "signup-name"],
  ["email", "signup-email"],
  ["password", "signup-password"],
  ["storeName", "signup-store"],
  ["slug", "signup-slug"],
];

function Rule({ met, children }) {
  return (
    <li className={cn("flex items-center gap-1.5", met && "text-foreground")}>
      {met ? <Check aria-hidden className="size-3.5 text-success" /> : <span aria-hidden className="mx-[5px] size-1 rounded-full bg-current" />}
      <span>{children}</span>
      <span className="sr-only">{met ? "(done)" : "(not yet)"}</span>
    </li>
  );
}

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
  const [failure, setFailure] = useState(null); // { text, canRetry, kind }
  const [progress, setProgress] = useState(INITIAL_STEPS); // [{ label, state }]
  const [note, setNote] = useState(null); // the retry note, or a lost connection
  const [closedText, setClosedText] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const codeRef = useRef(null);
  const headingRef = useRef(null);

  const set = (k) => (e) => {
    const v = e.target.value;
    setFields((f) => ({ ...f, [k]: v }));
    // the address is made from the store name, so a new name clears its error too
    const clear = k === "storeName" ? [k, "slug"] : [k];
    setErrors((x) => (clear.some((c) => x[c]) ? { ...x, ...Object.fromEntries(clear.map((c) => [c, undefined])) } : x));
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
        setCheck({ query, slug: b.slug || "", available: Boolean(b.available), message: b.message || null });
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
      const errs = r.body?.errors || {};
      setErrors(errs);
      const first = FIELD_IDS.find(([k]) => errs[k]);
      // the error under each field says what to fix; a summary only when none of them can
      if (first) requestAnimationFrame(() => document.getElementById(first[1])?.focus());
      else setFormError({ text: r.body?.error || "Check your details, then try again." });
    } else if (r.status === 403 && r.body?.code === "SIGNUPS_CLOSED") {
      closed(r.body);
    } else if (r.status === 429) {
      setFormError({ text: r.body?.error || "Too many tries from here. Wait a while, then try again." });
    } else {
      setFormError({ text: r.status === 0 ? OFFLINE : r.body?.error || SERVER, retry: true });
    }
  };

  // where the store's setup stands: a done answer moves on, failed shows why
  const leave = (url) => {
    setStep("done");
    window.location.assign(url);
  };
  const settle = (r) => {
    const b = r.body || {};
    if (r.status === 200 && b.status === "done") {
      if (Array.isArray(b.steps)) setProgress(b.steps);
      const url = b.redirect || b.loginUrl;
      if (url) leave(url);
      return !url; // done with neither: poll again
    }
    if (r.status === 200 && b.status === "provisioning") {
      if (Array.isArray(b.steps)) setProgress(b.steps);
      setNote(b.note || null);
      return true;
    }
    if (r.status === 200 && b.status === "failed") {
      if (Array.isArray(b.steps)) setProgress(b.steps);
      setNote(null);
      setFailure({ text: b.error || SERVER, canRetry: b.canRetry !== false, kind: b.failureKind || null });
      setStep("failed");
      return false;
    }
    if (r.status === 403 && b.code === "SIGNUPS_CLOSED") {
      closed(b);
      return false;
    }
    if (r.status === 0 || r.status === 429 || r.status >= 500) {
      // the store keeps being made on our side; keep asking
      setNote(LOST);
      return true;
    }
    // no signup in this browser any more (or it lapsed): start again
    setFailure({ text: b.error || SERVER, canRetry: false, kind: null });
    setStep("failed");
    return false;
  };

  // while working: ask every 1.5 s, one request at a time; a hidden tab asks
  // every 15 s and asks at once when it is shown again
  useEffect(() => {
    if (step !== "working") return undefined;
    let stopped = false;
    let timer = null;
    let inFlight = false;
    const tick = async () => {
      clearTimeout(timer);
      if (stopped || inFlight) return;
      inFlight = true;
      const r = await post("/api/signup/status");
      inFlight = false;
      if (stopped) return;
      if (settle(r)) timer = setTimeout(tick, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
    };
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    timer = setTimeout(tick, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // settle only sets state; the loop lives as long as the working step
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // verify ({ code }) or Try again ({ retry: true }): both queue the store's
  // setup and answer at once; the working step then polls
  const finish = async (body) => {
    if (busy) return;
    setBusy(true);
    setCodeError(null);
    const r = await post("/api/signup/verify", body);
    setBusy(false);
    const b = r.body || {};
    if (r.status === 200 && b.status === "provisioning") {
      setProgress(INITIAL_STEPS);
      setNote(null);
      setFailure(null);
      setStep("working");
    } else if (r.status === 200 && b.status === "done" && (b.redirect || b.loginUrl)) {
      leave(b.redirect || b.loginUrl);
    } else if (r.status === 200) {
      setFailure({ text: b.error || SERVER, canRetry: b.canRetry !== false, kind: b.failureKind || null });
      setStep("failed");
    } else if (r.status === 403 && b.code === "SIGNUPS_CLOSED") {
      closed(b);
    } else if (body.retry) {
      // a lost connection or a server error leaves the store as it was: try again later;
      // anything else (no signup here, lapsed) means start again
      const again = r.status === 0 || r.status === 429 || r.status >= 500;
      setFailure({ text: r.status === 0 ? OFFLINE : b.error || SERVER, canRetry: again, kind: failure?.kind || null });
      setStep("failed");
    } else {
      setStep("code");
      setCodeError(r.status === 0 ? OFFLINE : b.error || SERVER);
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

  const heading = (text, step) => (
    <div className="space-y-2">
      {step && <p className="text-[0.8125rem] text-muted-foreground">{step}</p>}
      <h1 ref={headingRef} tabIndex={-1} className="text-[1.75rem] leading-tight font-semibold tracking-[-0.01em] outline-none">
        {text}
      </h1>
    </div>
  );

  if (step === "closed") {
    return (
      <section data-signup="closed" className="space-y-4">
        {heading("Signups are closed right now")}
        <p className="text-muted-foreground">{closedText}</p>
        <a href="/contact" className="inline-block font-medium text-primary underline-offset-4 hover:underline">
          Tell us about your store
        </a>
      </section>
    );
  }

  const stepList = (
    <ol data-signup-steps className="space-y-3">
      {progress.map((x) => (
        <li key={x.label} data-step-state={x.state} className={cn("flex items-center gap-3", x.state === "waiting" && "text-muted-foreground")}>
          <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
            {x.state === "done" && <Check className="size-4 text-success" />}
            {x.state === "working" && <LoaderCircle className="size-4 text-primary motion-safe:animate-spin" />}
            {x.state === "failed" && <CircleAlert className="size-4 text-destructive" />}
            {x.state === "waiting" && <span className="size-1.5 rounded-full bg-current" />}
          </span>
          <span className={cn(x.state === "working" && "font-medium")}>{x.label}</span>
          <span className="sr-only">
            {x.state === "done" ? "(done)" : x.state === "working" ? "(working on it)" : x.state === "failed" ? "(stopped here)" : "(not yet)"}
          </span>
        </li>
      ))}
    </ol>
  );

  if (step === "working" || step === "done") {
    const current = progress.find((x) => x.state === "working");
    return (
      <section data-signup={step} className="space-y-6">
        <div className="space-y-3">
          {heading(step === "done" ? "Opening your store…" : "Setting up your store…")}
          <p className="text-muted-foreground">
            {step === "done"
              ? "Your store is ready. Taking you there now."
              : `We're making ${signup?.storeName || "your store"} at ${signup?.address || "its new address"}. This takes a little while; keep this page open.`}
          </p>
        </div>
        {stepList}
        {/* what a screen reader hears: the step being worked on, the retry note, done */}
        <div role="status" aria-live="polite" className="space-y-2">
          <p className="sr-only">{step === "done" ? "Your store is ready." : current ? `${current.label}…` : ""}</p>
          {step === "working" && note && (
            <p data-signup-note className="rounded-md border border-border bg-muted px-3 py-2 text-[0.8125rem] text-muted-foreground">
              {note}
            </p>
          )}
        </div>
      </section>
    );
  }

  if (step === "failed") {
    const needsUs = failure?.kind === "needs_operator";
    return (
      <section data-signup="failed" data-failure-kind={failure?.kind || undefined} className="space-y-6">
        <div className="space-y-3">
          {heading(needsUs ? "Your store is waiting on us" : "We couldn't finish setting up your store")}
          <p role="alert" className="text-muted-foreground">
            {failure?.text}
          </p>
          {failure?.canRetry && <p className="text-muted-foreground">Your details and code are kept. Trying again picks up where it stopped.</p>}
        </div>
        {failure?.kind && stepList}
        <div className="flex flex-wrap gap-2">
          {failure?.canRetry && (
            <Button size="lg" disabled={busy} onClick={() => finish({ retry: true })} className="h-10 px-4">
              {busy && <LoaderCircle aria-hidden className="motion-safe:animate-spin" />}
              {busy ? "Trying again…" : "Try again"}
            </Button>
          )}
          {!failure?.canRetry && (
            <Button size="lg" variant="outline" onClick={() => setStep("form")} className="h-10 px-4">
              Start again
            </Button>
          )}
        </div>
      </section>
    );
  }

  if (step === "code") {
    return (
      <section data-signup="code" className="space-y-8">
        <div className="space-y-3">
          {heading("Check your email", "Step 2 of 2")}
          <p className="text-muted-foreground">
            We sent a 6-digit code to <span className="font-medium break-all text-foreground">{signup?.email}</span>. It works for {signup?.codeMinutes || codeMinutes} minutes.
          </p>
        </div>
        <form onSubmit={verify} noValidate className="space-y-6">
          <Field id="signup-code" label="Code from the email" hint={codeError ? null : "Can't find it? Check your spam or promotions folder."} error={codeError}>
            <Input
              ref={codeRef}
              id="signup-code"
              name="code"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              spellCheck={false}
              maxLength={6}
              value={code}
              onChange={(e) => {
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                setCodeError(null);
              }}
              onPaste={(e) => {
                // "Your code: 123 456" pastes as 123456
                const digits = e.clipboardData.getData("text").replace(/\D/g, "");
                if (!digits) return;
                e.preventDefault();
                setCode(digits.slice(0, 6));
                setCodeError(null);
              }}
              aria-invalid={codeError ? true : undefined}
              aria-describedby={described("signup-code", codeError, !codeError)}
              className="h-12 max-w-56 px-4 font-mono text-2xl tracking-[0.4em] md:text-2xl"
            />
          </Field>
          <Button type="submit" size="lg" disabled={busy} className="h-10 w-full px-4 sm:w-auto">
            {busy && <LoaderCircle aria-hidden className="motion-safe:animate-spin" />}
            {busy ? "Checking your code…" : "Verify and create my store"}
          </Button>
        </form>
        <div className="space-y-3 border-t border-border pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" disabled={resendIn > 0 || busy} onClick={resend} data-signup-resend className="h-9 px-3">
              Send a new code
            </Button>
            {resendIn > 0 && (
              <p className="text-[0.8125rem] text-muted-foreground tabular-nums" data-signup-countdown aria-live="off">
                You can ask for a new code in {resendIn} seconds.
              </p>
            )}
          </div>
          {resendNote && (
            <p role="status" className={cn("text-[0.8125rem]", resendNote.error ? "text-destructive" : "text-muted-foreground")}>
              {resendNote.text}
            </p>
          )}
          <p className="text-[0.8125rem] text-muted-foreground">
            Wrong email?{" "}
            <button
              type="button"
              className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              onClick={() => setStep("form")}
            >
              Change your details
            </button>
          </p>
        </div>
      </section>
    );
  }

  // an address made from an empty or bad store name: the store name's own error says what to fix
  const slugError = (slugTouched || !errors.storeName ? errors.slug : null) || (check && !check.available && slug && check.slug === slug ? check.message : null);
  const address = slug ? `${slug}.${storeDomain}` : null;
  const checking = !empty && check?.query !== query;
  const free = !checking && check?.available && check.slug === slug;
  const pw = fields.password;
  const pwLong = pw.length >= 8;
  const pwNotEmail = pw.length > 0 && pw.trim().toLowerCase() !== fields.email.trim().toLowerCase();
  const inputCls = "h-10";
  return (
    <section data-signup="form" className="space-y-8">
      <div className="space-y-3">
        {heading("Create your store", "Step 1 of 2")}
        <p className="text-muted-foreground">Set up your account and pick your store's address. Your storefront is built from your Shopify products; nothing in your Shopify store changes.</p>
      </div>
      {formError && (
        <div role="alert" data-signup-error className="flex flex-wrap items-center gap-3 rounded-card border border-destructive/30 bg-destructive/5 p-3">
          <CircleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
          <p className="min-w-0 flex-1 text-destructive">{formError.text}</p>
          {formError.retry && (
            <Button type="button" variant="outline" size="sm" onClick={submit} disabled={busy}>
              Try again
            </Button>
          )}
        </div>
      )}
      <form onSubmit={submit} noValidate className="space-y-8">
        <fieldset className="space-y-6">
          <legend className="text-base font-semibold">About you</legend>
          <Field id="signup-name" label="Your name" error={errors.name}>
            <Input
              id="signup-name"
              name="name"
              autoComplete="name"
              maxLength={80}
              value={fields.name}
              onChange={set("name")}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={described("signup-name", errors.name)}
              className={inputCls}
            />
          </Field>
          <Field id="signup-email" label="Email" error={errors.email}>
            <Input
              id="signup-email"
              name="email"
              type="email"
              autoComplete="email"
              spellCheck={false}
              maxLength={200}
              value={fields.email}
              onChange={set("email")}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={described("signup-email", errors.email)}
              className={inputCls}
            />
          </Field>
          <Field
            id="signup-password"
            label="Password"
            error={errors.password}
            hint={
              <ul className="space-y-1" aria-label="Your password needs">
                <Rule met={pwLong}>At least 8 characters</Rule>
                <Rule met={pwNotEmail}>Not the same as your email</Rule>
              </ul>
            }
          >
            <div className="relative">
              <Input
                id="signup-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={200}
                value={fields.password}
                onChange={set("password")}
                aria-invalid={errors.password ? true : undefined}
                aria-describedby={described("signup-password", errors.password, true)}
                className={cn(inputCls, "pr-20")}
              />
              <button
                type="button"
                aria-controls="signup-password"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-1 right-1 inline-flex items-center gap-1.5 rounded-md px-2 text-[0.8125rem] font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {showPassword ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
                {showPassword ? "Hide" : "Show"}
                <span className="sr-only"> password</span>
              </button>
            </div>
          </Field>
        </fieldset>

        <div className="border-t border-border pt-8">
          <fieldset className="space-y-6">
            <legend className="text-base font-semibold">Your store</legend>
            <Field id="signup-store" label="Store name" error={errors.storeName}>
              <Input
                id="signup-store"
                name="storeName"
                autoComplete="organization"
                maxLength={60}
                value={fields.storeName}
                onChange={set("storeName")}
                aria-invalid={errors.storeName ? true : undefined}
                aria-describedby={described("signup-store", errors.storeName)}
                className={inputCls}
              />
            </Field>
            <Field
              id="signup-slug"
              label="Store address"
              error={slugError}
              hint={
                <div className="space-y-2">
                  <p>Made from your store name. You can change it now; it's harder to change later.</p>
                  <div data-signup-address className={cn("flex items-start gap-2 rounded-md border px-3 py-2", slugError && address ? "border-destructive/30 bg-destructive/5" : "border-border bg-card")}>
                    <Globe aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      {address ? (
                        <>
                          <p className="font-mono text-sm break-all text-foreground">{address}</p>
                          <p aria-live="polite" className={cn("mt-0.5", slugError ? "text-destructive" : free ? "text-success" : "text-muted-foreground")}>
                            {slugError ? (errors.slug ? "Fix the address above." : "Not available. Try another address.") : checking ? "Checking if it's free…" : free ? `${address} is free.` : `Your store will be at ${address}.`}
                          </p>
                        </>
                      ) : (
                        <p>Type your store name to see your address.</p>
                      )}
                    </div>
                    {address && !slugError && !checking && free && <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />}
                    {address && checking && <LoaderCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground motion-safe:animate-spin" />}
                  </div>
                </div>
              }
            >
              <div
                className={cn(
                  "flex h-10 items-stretch overflow-hidden rounded-md border border-input bg-muted focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background",
                  slugError && "border-destructive",
                )}
              >
                <input
                  id="signup-slug"
                  name="slug"
                  autoComplete="off"
                  autoCapitalize="none"
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
                  className="min-w-0 flex-1 bg-transparent px-2.5 font-mono text-base outline-none md:text-sm"
                />
                <span aria-hidden className="flex max-w-[45%] shrink-0 items-center truncate border-l border-input px-2.5 font-mono text-[0.8125rem] text-muted-foreground">
                  .{storeDomain}
                </span>
              </div>
            </Field>
          </fieldset>
        </div>

        <div className="space-y-3 border-t border-border pt-8">
          <Button type="submit" size="lg" disabled={busy} className="h-10 w-full px-4 sm:w-auto">
            {busy && <LoaderCircle aria-hidden className="motion-safe:animate-spin" />}
            {busy ? "Sending your code…" : "Email me a code"}
          </Button>
          <p className="text-[0.8125rem] text-muted-foreground">We'll email you a 6-digit code to confirm it's you. Nothing is created until you type it.</p>
        </div>
      </form>
    </section>
  );
}
