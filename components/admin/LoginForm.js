"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/console/Button";
import { Field, Input } from "@/components/console/fields";
import { Banner } from "@/components/console/Banner";

// S26 (MC01): individual email+password sign-in. Leaving email empty falls
// back to the store's bootstrap/legacy shared password — the server only
// accepts that while the tenant has no member users (or in legacy mode).
// S50: renders inside the (auth) card shell; lands on the Dashboard.
export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(email ? { email, password } : { password }),
    });
    if (res.ok) {
      router.push("/admin/dashboard");
      router.refresh();
      return;
    }
    const data = await res.json().catch(() => ({}));
    setError(data.error || `Login failed (${res.status})`);
    setBusy(false);
  }

  async function forgot() {
    if (!email) {
      setError("Enter your email first, then tap “Forgot password?”");
      return;
    }
    setError("");
    setBusy(true);
    const res = await fetch("/api/admin/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    setNotice(data.message || data.error || "If that account exists, a reset link is on its way.");
    setBusy(false);
  }

  return (
    <div>
      <h1 className="text-base font-semibold text-fg">Sign in</h1>
      <p className="mt-0.5 text-xs text-fg-muted">Offers, orders, storefront and settings.</p>
      <form onSubmit={submit} className="mt-5 space-y-4">
        <Field label="Email" htmlFor="login-email" hint="No account email yet? Leave it empty to use the setup password.">
          <Input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" />
        </Field>
        <Field label="Password" htmlFor="login-password">
          <Input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        {error && <Banner tone="danger">{error}</Banner>}
        {notice && <Banner tone="info">{notice}</Banner>}
        <Button type="submit" variant="primary" busy={busy} disabled={!password} className="w-full">
          Sign in
        </Button>
        <div className="text-center">
          <button type="button" onClick={forgot} disabled={busy} className="rounded text-xs text-fg-muted underline-offset-2 focus-ring hover:text-fg hover:underline">
            Forgot password?
          </button>
        </div>
      </form>
    </div>
  );
}
