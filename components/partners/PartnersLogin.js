"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/console/Button";
import { Field, Input } from "@/components/console/fields";
import { Banner } from "@/components/console/Banner";

// Agency sign-in + member-invite acceptance (S48, redesigned S50): renders
// inside the centered auth card shell in app/(console)/partners/page.js,
// matching the admin (auth) layout's look.
export default function PartnersLogin() {
  const router = useRouter();
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ email: "", password: "", token: "", name: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  async function post(body) {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/partners/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setErr(json.error || "Request failed");
      return null;
    }
    return json;
  }

  return (
    <div>
      <h1 className="text-base font-semibold text-fg">{mode === "login" ? "Sign in" : "Join your agency"}</h1>
      <p className="mt-0.5 text-xs text-fg-muted">For agencies managing client stores. Access exists only where a client granted it.</p>

      {mode === "login" ? (
        <form
          className="mt-5 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await post({ action: "login", email: form.email, password: form.password })) router.refresh();
          }}
        >
          {err && <Banner tone="danger">{err}</Banner>}
          {note && <Banner tone="success">{note}</Banner>}
          <Field label="Email" htmlFor="partners-email">
            <Input id="partners-email" type="email" required autoFocus autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Password" htmlFor="partners-password">
            <Input id="partners-password" type="password" required autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          <Button type="submit" variant="primary" busy={busy} className="w-full">
            Sign in
          </Button>
          <div className="text-center">
            <button
              type="button"
              onClick={() => {
                setMode("invite");
                setErr(null);
              }}
              className="rounded text-xs text-fg-muted underline-offset-2 focus-ring hover:text-fg hover:underline"
            >
              Have an invitation code?
            </button>
          </div>
        </form>
      ) : (
        <form
          className="mt-5 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await post({ action: "accept_invite", token: form.token.trim(), name: form.name, password: form.password });
            if (r) {
              setNote(`Account ready for ${r.email} — sign in below.`);
              setMode("login");
              setForm({ ...form, email: r.email, password: "" });
            }
          }}
        >
          {err && <Banner tone="danger">{err}</Banner>}
          <Field label="Invitation code" htmlFor="partners-token">
            <Input id="partners-token" mono required autoFocus value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />
          </Field>
          <Field label="Your name" htmlFor="partners-name">
            <Input id="partners-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Choose a password" htmlFor="partners-new-password" hint="10+ characters.">
            <Input id="partners-new-password" type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          <Button type="submit" variant="primary" busy={busy} className="w-full">
            Join your agency
          </Button>
          <div className="text-center">
            <button
              type="button"
              onClick={() => {
                setMode("login");
                setErr(null);
              }}
              className="rounded text-xs text-fg-muted underline-offset-2 focus-ring hover:text-fg hover:underline"
            >
              Back to sign-in
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
