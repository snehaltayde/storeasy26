"use client";

// Choose a new password from a reset email's link (on components/ui since
// Phase 2 line 11). POST /api/admin/reset spends the token and signs every
// session out; then the sign-in page.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
    }).catch(() => null);
    if (res?.ok) {
      setDone(true);
      setTimeout(() => router.push("/admin/login"), 1200);
      return;
    }
    const data = res ? await res.json().catch(() => ({})) : {};
    setError(data.error || (res ? `Reset failed (${res.status})` : "We couldn't reach your store. Check your connection, then try again."));
    setBusy(false);
  }

  if (done) {
    return (
      <section data-auth="reset-done" role="status" className="space-y-3">
        <CircleCheck aria-hidden className="size-6 text-success" />
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-[-0.01em]">Password updated</h1>
        <p className="text-muted-foreground">All your other sessions are signed out. Taking you to the sign-in page…</p>
      </section>
    );
  }

  return (
    <section data-auth="reset" className="space-y-8">
      <h1 className="text-[1.75rem] leading-tight font-semibold tracking-[-0.01em]">Choose a new password</h1>
      <form onSubmit={submit} className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="reset-pw">New password</Label>
          <Input id="reset-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="new-password" required aria-describedby="reset-pw-hint" className="h-10" />
          <p id="reset-pw-hint" className="text-[0.8125rem] text-muted-foreground">
            At least 8 characters.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="reset-pw2">Confirm password</Label>
          <Input id="reset-pw2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required className="h-10" />
        </div>
        {error && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="border-t border-border pt-8">
          <Button type="submit" size="lg" disabled={busy} className="h-10 w-full px-4 sm:w-auto">
            {busy && <LoaderCircle aria-hidden className="motion-safe:animate-spin" />}
            Set password
          </Button>
        </div>
      </form>
    </section>
  );
}
