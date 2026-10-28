"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/console/Button";
import { Field, Input } from "@/components/console/fields";
import { Banner } from "@/components/console/Banner";

export default function AcceptInviteForm({ token, storeName }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (password.length < 8) return setError("Password must be at least 8 characters");
    if (password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    const res = await fetch("/api/admin/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name, password }),
    });
    if (res.ok) {
      router.push("/admin/dashboard");
      router.refresh();
      return;
    }
    const data = await res.json().catch(() => ({}));
    setError(data.error || `Could not accept the invitation (${res.status})`);
    setBusy(false);
  }

  return (
    <div>
      <h1 className="text-base font-semibold text-fg">Join {storeName}</h1>
      <p className="mt-0.5 text-xs text-fg-muted">Set up your console account to accept the invitation.</p>
      <form onSubmit={submit} className="mt-5 space-y-4">
        <Field label="Your name" htmlFor="inv-name">
          <Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Password" htmlFor="inv-pw" hint="At least 8 characters.">
          <Input id="inv-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label="Confirm password" htmlFor="inv-pw2">
          <Input id="inv-pw2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </Field>
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" variant="primary" busy={busy} disabled={!password} className="w-full">
          Accept invitation
        </Button>
      </form>
    </div>
  );
}
