"use client";

// Accept an invitation to this store's console. Phase 1 line 9: the page peeks
// at the invite first (GET /api/admin/accept-invite, which never spends it) to
// show the store and the invited email; an existing Storeasy account signs in
// with its current password (a wrong one leaves the invite usable), a new one
// chooses a name and password. Then /admin, which leads a new owner to
// /admin/onboarding. Built on components/ui in the signup screens' words and
// shapes (data-invite="<state>": reading, unusable, new, existing).
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, CircleAlert, Eye, EyeOff, LoaderCircle, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/components/ui/utils";

const OFFLINE = "We couldn't reach your store. Check your connection, then try again. Your invitation still works.";
const THROTTLED = "Too many tries. Wait up to 15 minutes, then try again. Your invitation still works.";
const LOGIN = "/admin/login";

function Field({ id, label, hint, error, children }) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-[0.8125rem] text-destructive">
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

const described = (id, error, hint) => [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(" ") || undefined;

function Rule({ met, children }) {
  return (
    <li className={cn("flex items-center gap-1.5", met && "text-foreground")}>
      {met ? <Check aria-hidden className="size-3.5 text-success" /> : <span aria-hidden className="mx-[5px] size-1 rounded-full bg-current" />}
      <span>{children}</span>
      <span className="sr-only">{met ? "(done)" : "(not yet)"}</span>
    </li>
  );
}

function PasswordInput({ id, value, onChange, show, onToggle, autoComplete, error, hint, autoFocus }) {
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        maxLength={200}
        required
        autoFocus={autoFocus}
        aria-invalid={error ? true : undefined}
        aria-describedby={described(id, error, hint)}
        className="h-10 pr-20"
      />
      {onToggle && (
        <button
          type="button"
          aria-controls={id}
          onClick={onToggle}
          className="absolute inset-y-1 right-1 inline-flex items-center gap-1.5 rounded-md px-2 text-[0.8125rem] font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {show ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
          {show ? "Hide" : "Show"}
          <span className="sr-only"> password</span>
        </button>
      )}
    </div>
  );
}

export default function AcceptInviteForm({ token, storeName }) {
  const [invite, setInvite] = useState(null); // { email, existingAccount, storeName }
  const [peekError, setPeekError] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState({}); // { password, confirm }
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const headingRef = useRef(null);
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    fetch(`/api/admin/accept-invite?token=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!alive) return;
        if (res.ok && body.ok) setInvite(body);
        else if (res.status === 429) setPeekError("Too many tries from here. Wait a few minutes, then reload this page. Your invitation still works.");
        else setPeekError(body.error || "We couldn't read this invitation. Reload the page to try again.");
      })
      .catch(() => alive && setPeekError("We couldn't reach your store. Check your connection, then reload this page."));
    return () => {
      alive = false;
    };
  }, [token]);

  useEffect(() => {
    if (peekError) headingRef.current?.focus();
  }, [peekError]);

  const existing = Boolean(invite?.existingAccount);
  const store = invite?.storeName || storeName || "this store";

  const focus = (id) => requestAnimationFrame(() => document.getElementById(id)?.focus());

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setFormError("");
    const errs = {};
    if (existing) {
      if (!password) errs.password = "Enter your Storeasy password.";
    } else {
      if (password.length < 8) errs.password = "Use at least 8 characters.";
      else if (password.trim().toLowerCase() === invite.email.trim().toLowerCase()) errs.password = "Use a password that isn't your email.";
      else if (password !== confirm) errs.confirm = "The two passwords don't match.";
    }
    setErrors(errs);
    if (errs.password) return focus("inv-pw");
    if (errs.confirm) return focus("inv-pw2");
    setBusy(true);
    let res = null;
    try {
      res = await fetch("/api/admin/accept-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name, password }),
      });
    } catch {
      res = null;
    }
    if (res?.ok) {
      router.push("/admin");
      router.refresh();
      return;
    }
    setBusy(false);
    if (!res) return setFormError(OFFLINE);
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) return setFormError(THROTTLED);
    if (data.code === "WRONG_PASSWORD") {
      setErrors({ password: "That isn't the password for your Storeasy account. Your invitation still works: try again." });
      return focus("inv-pw");
    }
    if (res.status >= 500) return setFormError("Something went wrong on our side. Try again in a moment. Your invitation still works.");
    setFormError(data.error || "We couldn't accept the invitation. Try again.");
  }

  if (peekError) {
    return (
      <section data-invite="unusable" role="alert" className="space-y-6">
        <div className="space-y-3">
          <h1 ref={headingRef} tabIndex={-1} className="text-[1.75rem] leading-tight font-semibold tracking-[-0.01em] outline-none">
            This invitation can&apos;t be used
          </h1>
          <p className="text-muted-foreground">{peekError}</p>
        </div>
        <Button asChild variant="outline" size="lg" className="h-10 px-4">
          <a href={LOGIN}>Go to the sign-in page</a>
        </Button>
      </section>
    );
  }
  if (!invite) {
    return (
      <section data-invite="reading" aria-busy="true" aria-label="Reading your invitation" className="space-y-8">
        <div className="space-y-3">
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
        <div className="space-y-6">
          {[0, 1].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
          <Skeleton className="h-10 w-44" />
        </div>
      </section>
    );
  }

  const pwLong = password.length >= 8;
  const pwNotEmail = password.length > 0 && password.trim().toLowerCase() !== invite.email.trim().toLowerCase();

  return (
    <section data-invite={existing ? "existing" : "new"} className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-[-0.01em] break-words">Join {store}</h1>
        <p className="text-muted-foreground">{existing ? "You already have a Storeasy account. Sign in with it to add this store to it." : "You've been invited to run this store's console. Choose a password to accept."}</p>
        <p className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
          <Mail aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">Invited as</span>
          <span className="min-w-0 truncate font-medium" title={invite.email}>
            {invite.email}
          </span>
        </p>
      </div>

      {formError && (
        <div role="alert" className="flex items-start gap-3 rounded-card border border-destructive/30 bg-destructive/5 p-3">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="min-w-0 text-destructive">{formError}</p>
        </div>
      )}

      <form onSubmit={submit} noValidate className="space-y-8">
        {existing ? (
          <Field
            id="inv-pw"
            label="Your Storeasy password"
            error={errors.password}
            hint={
              <>
                Forgot it? On the{" "}
                <a href={LOGIN} className="font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                  sign-in page
                </a>
                , type {invite.email} and choose “Forgot password?”. Then open this invitation again.
              </>
            }
          >
            <PasswordInput id="inv-pw" value={password} onChange={(e) => (setPassword(e.target.value), errors.password && setErrors({}))} show={show} onToggle={() => setShow((v) => !v)} autoComplete="current-password" error={errors.password} hint autoFocus />
          </Field>
        ) : (
          <fieldset className="space-y-6">
            <legend className="sr-only">Your account</legend>
            <Field id="inv-name" label="Your name">
              <Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} autoFocus className="h-10" />
            </Field>
            <Field
              id="inv-pw"
              label="Password"
              error={errors.password}
              hint={
                <ul className="space-y-1" aria-label="Your password needs">
                  <Rule met={pwLong}>At least 8 characters</Rule>
                  <Rule met={pwNotEmail}>Not the same as your email</Rule>
                </ul>
              }
            >
              <PasswordInput id="inv-pw" value={password} onChange={(e) => (setPassword(e.target.value), errors.password && setErrors({}))} show={show} onToggle={() => setShow((v) => !v)} autoComplete="new-password" error={errors.password} hint />
            </Field>
            <Field id="inv-pw2" label="Confirm password" error={errors.confirm}>
              <PasswordInput id="inv-pw2" value={confirm} onChange={(e) => (setConfirm(e.target.value), errors.confirm && setErrors({}))} show={show} autoComplete="new-password" error={errors.confirm} />
            </Field>
          </fieldset>
        )}

        <div className="space-y-3 border-t border-border pt-8">
          <Button type="submit" size="lg" disabled={busy} className="h-10 w-full px-4 sm:w-auto">
            {busy && <LoaderCircle aria-hidden className="motion-safe:animate-spin" />}
            {busy ? "Accepting…" : "Accept invitation"}
          </Button>
          <p className="text-[0.8125rem] text-muted-foreground">{existing ? "Your password and your other stores stay as they are." : "You'll use this email and password to sign in to the store's console."}</p>
        </div>
      </form>
    </section>
  );
}
