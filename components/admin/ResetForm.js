"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/console/Button";
import { Field, Input } from "@/components/console/fields";
import { Banner } from "@/components/console/Banner";

export default function ResetForm({ token }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (password.length < 8) return setError("Password must be at least 8 characters");
    if (password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    const res = await fetch("/api/admin/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    if (res.ok) {
      setDone(true);
      setTimeout(() => router.push("/admin/login"), 1200);
      return;
    }
    const data = await res.json().catch(() => ({}));
    setError(data.error || `Reset failed (${res.status})`);
    setBusy(false);
  }

  if (done) {
    return (
      <div>
        <h1 className="text-base font-semibold text-fg">Password updated</h1>
        <p className="mt-2 text-sm text-fg-muted">All previous sessions are signed out. Taking you to the login…</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-base font-semibold text-fg">Choose a new password</h1>
      <form onSubmit={submit} className="mt-5 space-y-4">
        <Field label="New password" htmlFor="reset-pw" hint="At least 8 characters.">
          <Input id="reset-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="new-password" required />
        </Field>
        <Field label="Confirm password" htmlFor="reset-pw2">
          <Input id="reset-pw2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </Field>
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" variant="primary" busy={busy} className="w-full">
          Set password
        </Button>
      </form>
    </div>
  );
}
