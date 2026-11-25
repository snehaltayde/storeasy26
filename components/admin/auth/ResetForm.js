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
import { AuthFrame, StoreName } from "@/components/admin/auth/AuthFrame";

export default function ResetForm({ token, storeName = null }) {
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
    setError(data.error || (res ? "We couldn't set your password. Try again in a moment." : "We couldn't reach your store. Check your connection, then try again."));
    setBusy(false);
  }

  if (done) {
    return (
      <AuthFrame data-auth="reset-done" role="status" title="Password updated" intro={<StoreName name={storeName} />}>
        <div className="flex items-start gap-3 py-2">
          <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
          <p className="text-muted-foreground">All your other sessions are signed out. Taking you to the sign-in page…</p>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame data-auth="reset" title="Choose a new password" intro={<StoreName name={storeName} />}>
      <form onSubmit={submit} className="space-y-5 py-2">
        <div className="space-y-1.5">
          <Label htmlFor="reset-pw">New password</Label>
          <Input id="reset-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="new-password" required aria-describedby="reset-pw-hint" className="h-10" />
          <p id="reset-pw-hint" className="text-[0.8125rem] text-muted-foreground">
            At least 8 characters.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="reset-pw2">Confirm password</Label>
          <Input id="reset-pw2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required className="h-10" />
        </div>
        {error && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="pt-1">
          <Button type="submit" size="lg" disabled={busy} className="h-10 w-full">
            {busy && <LoaderCircle aria-hidden className="motion-safe:animate-spin" />}
            Set password
          </Button>
        </div>
      </form>
    </AuthFrame>
  );
}
