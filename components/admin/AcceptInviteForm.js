"use client";

// Accept an invitation to this store's console. Phase 1 line 9: the page peeks
// at the invite first (GET /api/admin/accept-invite, which never spends it) to
// show the store and the invited email; an existing Storeasy account signs in
// with its current password (a wrong one leaves the invite usable), a new one
// chooses a name and password. Then /admin, which leads a new owner to
// /admin/onboarding.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/console/Button";
import { Field, Input } from "@/components/console/fields";
import { Banner } from "@/components/console/Banner";

export default function AcceptInviteForm({ token, storeName }) {
  const [invite, setInvite] = useState(null); // { email, existingAccount, storeName }
  const [peekError, setPeekError] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    fetch(`/api/admin/accept-invite?token=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!alive) return;
        if (res.ok && body.ok) setInvite(body);
        else setPeekError(body.error || "We couldn't read this invitation. Reload the page to try again.");
      })
      .catch(() => alive && setPeekError("We couldn't reach the server. Reload the page to try again."));
    return () => {
      alive = false;
    };
  }, [token]);

  const existing = Boolean(invite?.existingAccount);
  const store = invite?.storeName || storeName;

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!existing) {
      if (password.length < 8) return setError("Use at least 8 characters.");
      if (password !== confirm) return setError("The passwords don't match.");
    } else if (!password) return setError("Enter your Storeasy password.");
    setBusy(true);
    const res = await fetch("/api/admin/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name, password }),
    }).catch(() => null);
    if (res?.ok) {
      router.push("/admin");
      router.refresh();
      return;
    }
    const data = (await res?.json().catch(() => ({}))) || {};
    setError(data.error || "We couldn't accept the invitation. Try again.");
    setBusy(false);
  }

  if (peekError) {
    return (
      <div>
        <h1 className="text-base font-semibold text-fg">This invitation can't be used</h1>
        <p className="mt-2 text-sm text-fg-muted">{peekError}</p>
      </div>
    );
  }
  if (!invite) {
    return (
      <div aria-busy="true" aria-label="Reading your invitation" className="space-y-3">
        <div className="h-5 w-2/3 animate-pulse rounded bg-surface-sunken motion-reduce:animate-none" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-surface-sunken motion-reduce:animate-none" />
        <div className="h-9 w-full animate-pulse rounded bg-surface-sunken motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="truncate text-base font-semibold text-fg" title={`Join ${store}`}>
        Join {store}
      </h1>
      <p className="mt-0.5 text-xs text-fg-muted">
        {existing ? (
          <>
            You already have a Storeasy account as <span className="font-medium text-fg">{invite.email}</span>. Enter its password to accept.
          </>
        ) : (
          <>
            Invited as <span className="font-medium text-fg">{invite.email}</span>. Choose a password to accept.
          </>
        )}
      </p>
      <form onSubmit={submit} className="mt-5 space-y-4">
        {existing ? (
          <Field label="Your Storeasy password" htmlFor="inv-pw">
            <Input id="inv-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
          </Field>
        ) : (
          <>
            <Field label="Your name" htmlFor="inv-name">
              <Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus />
            </Field>
            <Field label="Password" htmlFor="inv-pw" hint="At least 8 characters.">
              <Input id="inv-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
            </Field>
            <Field label="Confirm password" htmlFor="inv-pw2">
              <Input id="inv-pw2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
            </Field>
          </>
        )}
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" variant="primary" busy={busy} disabled={!password} className="w-full">
          Accept invitation
        </Button>
        {existing && (
          <p className="text-center text-xs text-fg-muted">
            Forgot it? Use <a className="underline" href="/admin/login">Forgot password</a> on the sign-in page, then open this link again.
          </p>
        )}
      </form>
    </div>
  );
}
