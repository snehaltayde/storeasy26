"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Field, Input } from "@/components/console/fields";
import { CopyButton, SecretReveal } from "@/components/console/Copy";

// S26 (OP01, redesigned S50): operator email+password with MANDATORY TOTP.
// First sign-in returns the enrollment secret once; the first valid code
// confirms it. Leaving email empty uses the legacy platform password —
// accepted only while no operator user exists (bootstrap). Rendered as the
// same centered auth card the merchant console uses (implemented locally —
// /platform has no (auth) route group).
export default function PlatformLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [enroll, setEnroll] = useState(null); // { secret, otpauth }
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body = email ? { email, password, ...(totp ? { totp } : {}) } : { password };
    const res = await fetch("/api/platform/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.enroll) {
      setEnroll({ secret: data.secret, otpauth: data.otpauth });
      setBusy(false);
      return;
    }
    if (res.ok) {
      router.refresh();
      return;
    }
    setError(data.error || `Login failed (${res.status})`);
    setBusy(false);
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="mb-6 text-center">
        <p className="text-lg font-semibold tracking-tight text-fg">Storeasy platform</p>
        <p className="text-xs text-fg-subtle">Operator console · tenants, onboarding, health</p>
      </div>
      <div className="w-full max-w-sm rounded-card border border-edge bg-surface p-6 shadow-card">
        {enroll && (
          <div className="mb-5">
            <p className="text-sm font-semibold text-fg">Set up your authenticator</p>
            <p className="mt-1 text-xs text-fg-muted">
              Add this secret to your authenticator app, then enter the current 6-digit code below and sign in again. No QR needed — scan
              apps accept manual entry.
            </p>
            <div className="mt-2">
              <SecretReveal label="TOTP secret" value={enroll.secret} note="Shown once — add it to your app now; it can't be retrieved later." />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-surface-sunken px-2.5 py-1.5 font-mono text-[11px] text-fg-muted">{enroll.otpauth}</code>
              <CopyButton value={enroll.otpauth} label="Copy otpauth URL" />
            </div>
          </div>
        )}
        <form onSubmit={submit} className="space-y-3">
          <Field label="Operator email" htmlFor="pl-email" hint="First platform setup? Leave empty to use the bootstrap operator password.">
            <Input
              id="pl-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@storeasy.dev"
              autoFocus
              autoComplete="username"
            />
          </Field>
          <Field label="Password" htmlFor="pl-password" required>
            <Input
              id="pl-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <Field label="Authenticator code" htmlFor="pl-totp" hint="6 digits from your authenticator app.">
            <Input
              id="pl-totp"
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              mono
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              autoComplete="one-time-code"
            />
          </Field>
          {error && <Banner tone="danger">{error}</Banner>}
          <Button type="submit" variant="primary" busy={busy} disabled={!password} className="w-full">
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
