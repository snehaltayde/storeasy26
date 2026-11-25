"use client";

// Sign in to the store's console (S26; on components/ui since Phase 2 line 11,
// in the accept-invite and signup screens' column and words). Email and
// password; leaving the email empty falls back to the store's setup password,
// which the server accepts only while the store has no member accounts. The
// lockout and every refusal are the server's (POST /api/admin/login): this
// form shows its words. "Forgot password?" posts the email to
// /api/admin/recover, which always answers the same way.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, Info, LoaderCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
    }).catch(() => null);
    if (res?.ok) {
      router.push("/admin");
      router.refresh();
      return;
    }
    const data = res ? await res.json().catch(() => ({})) : {};
    setError(data.error || (res ? `Sign-in failed (${res.status})` : "We couldn't reach your store. Check your connection, then try again."));
    setBusy(false);
  }

  async function forgot() {
    if (!email) {
      setError("Enter your email first, then choose “Forgot password?”");
      return;
    }
    setError("");
    setBusy(true);
    const res = await fetch("/api/admin/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    setNotice(data.message || data.error || "If that account exists, a reset link is on its way.");
    setBusy(false);
  }

  return (
    <section data-auth="login" className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-[-0.01em]">Sign in</h1>
        <p className="text-muted-foreground">Orders, offers, your storefront and settings.</p>
      </div>
      <form onSubmit={submit} className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="login-email">Email</Label>
          <Input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} aria-describedby="login-email-hint" className="h-10" />
          <p id="login-email-hint" className="text-[0.8125rem] text-muted-foreground">
            No account email yet? Leave it empty to use the setup password.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="login-password">Password</Label>
          <Input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required className="h-10" />
        </div>
        {error && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert variant="info" role="status">
            <Info aria-hidden />
            <AlertDescription className="text-info">{notice}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-3 border-t border-border pt-8 sm:flex-row sm:items-center">
          <Button type="submit" size="lg" disabled={busy || !password} className="h-10 w-full px-4 sm:w-auto">
            {busy && <LoaderCircle aria-hidden className="motion-safe:animate-spin" />}
            Sign in
          </Button>
          <Button type="button" variant="link" onClick={forgot} disabled={busy} className="h-10 px-0 text-muted-foreground sm:ml-auto">
            Forgot password?
          </Button>
        </div>
      </form>
    </section>
  );
}
