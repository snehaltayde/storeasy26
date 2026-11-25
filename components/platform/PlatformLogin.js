"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, KeyRound, LoaderCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/kit/copy-button";
import { StoreasyMark } from "@/components/kit/storeasy-mark";
import { LOGIN, loginError } from "./loginWords";

// The operator sign-in (S26, Phase 3 line 0 on components/ui): email and
// password with a mandatory authenticator code. The first sign-in returns the
// authenticator key once (shown here with Copy); the first good code confirms
// it. An empty email uses the setup (bootstrap) password, accepted only while
// no operator account exists. configured=false: PLATFORM_ADMIN_PASSWORD is
// unset, so only the "not set up" card shows. The ids #pl-email, #pl-password
// and #pl-totp are what scripts/drill.js and the drills type into.
function Field({ id, label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-[0.8125rem] text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

// The page: the Storeasy lockup (the page's one heading) above one card, at
// most 384px wide, centred. intro is the line under the name.
function Frame({ intro, children }) {
  return (
    <main data-platform="sign-in" className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12 text-sm text-foreground">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-start gap-3">
          <StoreasyMark className="size-8" />
          <div className="min-w-0 space-y-0.5">
            <h1 className="text-lg leading-8 font-semibold">{LOGIN.title}</h1>
            {intro && <p className="text-muted-foreground">{intro}</p>}
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}

export default function PlatformLogin({ configured = true }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [enroll, setEnroll] = useState(null); // { secret, otpauth }
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const enrollHeading = useRef(null);
  // The key appears above the form: move focus to its heading so a screen
  // reader reads it, and Tab goes on to Copy and then the code field.
  useEffect(() => {
    if (enroll) enrollHeading.current?.focus();
  }, [enroll]);

  if (!configured) {
    return (
      <Frame>
        <Card>
          <CardContent>
            <Alert variant="warning" data-platform="not-configured">
              <CircleAlert aria-hidden />
              <AlertTitle>{LOGIN.notConfiguredTitle}</AlertTitle>
              <AlertDescription>{LOGIN.notConfiguredBody}</AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </Frame>
    );
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body = email ? { email, password, ...(totp ? { totp } : {}) } : { password };
    let res;
    let data = {};
    try {
      res = await fetch("/api/platform/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      data = await res.json().catch(() => ({}));
    } catch {
      setError("We couldn't reach the server. Check your connection and try again.");
      setBusy(false);
      return;
    }
    if (res.ok && data.enroll) {
      setEnroll({ secret: data.secret, otpauth: data.otpauth });
      setBusy(false);
      return;
    }
    if (res.ok) {
      router.refresh();
      return;
    }
    setError(loginError(res.status, data.error));
    setBusy(false);
  }

  return (
    <Frame intro={LOGIN.intro}>
      <Card>
        <CardContent className="space-y-5">
          {enroll && (
            <section data-platform="enroll" aria-labelledby="pl-enroll-title" className="-mx-1 space-y-3 rounded-md bg-muted p-3">
              <div className="flex items-start gap-2.5">
                <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="space-y-1">
                  <h2 id="pl-enroll-title" ref={enrollHeading} tabIndex={-1} className="text-sm font-medium outline-none">
                    {LOGIN.enrollTitle}
                  </h2>
                  <p className="text-[0.8125rem] text-muted-foreground">{LOGIN.enrollBody}</p>
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-[0.8125rem] font-medium">{LOGIN.enrollKey}</p>
                <CopyButton id="pl-totp-secret" value={enroll.secret} label="the authenticator key" />
                <p className="flex items-start gap-1.5 text-[0.8125rem] text-warning-text">
                  <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  {LOGIN.enrollOnce}
                </p>
              </div>
              {enroll.otpauth && (
                <details className="group text-[0.8125rem]">
                  <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-muted">
                    {LOGIN.enrollLink}
                  </summary>
                  <CopyButton value={enroll.otpauth} label="the setup link" className="mt-2" />
                </details>
              )}
            </section>
          )}
          <form onSubmit={submit} className="space-y-4" noValidate aria-busy={busy || undefined}>
            <Field id="pl-email" label={LOGIN.email} hint={enroll ? null : LOGIN.emailHint}>
              <Input id="pl-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@storeasy.dev" autoFocus autoComplete="username" aria-describedby={enroll ? undefined : "pl-email-hint"} />
            </Field>
            <Field id="pl-password" label={LOGIN.password}>
              <Input id="pl-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </Field>
            <Field id="pl-totp" label={LOGIN.totp} hint={enroll ? LOGIN.totpHintEnroll : LOGIN.totpHint}>
              <Input
                id="pl-totp"
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                className="h-10 font-mono text-base tracking-[0.4em] tabular-nums placeholder:tracking-[0.4em]"
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                autoComplete="one-time-code"
                aria-describedby="pl-totp-hint"
              />
            </Field>
            {error && (
              <Alert variant="destructive" data-platform="sign-in-error">
                <CircleAlert aria-hidden />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={!password || busy} className="h-10 w-full">
              {busy && <LoaderCircle aria-hidden className="motion-safe:animate-spin" />}
              {busy ? LOGIN.busy : LOGIN.submit}
            </Button>
          </form>
        </CardContent>
      </Card>
    </Frame>
  );
}
