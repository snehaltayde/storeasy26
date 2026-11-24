import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { signupClosedAnswer, signupStoreDomain, CODE_TTL_MS, RESEND_GAP_MS } from "@/lib/platform/signup";
import SignupFlow from "@/components/admin/signup/SignupFlow";

// Self-serve signup (Phase 1 line 1) on the Storeasy marketing host only: a
// store host gets the 404 page. Closed (the ff_self-signup kill switch, or no
// store domain set) says so and points to /contact; unavailable (no control
// plane) says to come back. Open: the form, then the email code, then the new
// store (components/admin/signup/SignupFlow.js).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Create your store · Storeasy", robots: { index: false } };

function Frame({ children }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[640px] flex-col px-4 py-12 text-sm text-foreground md:px-6">
      <p className="mb-8 text-base font-semibold">
        Store<span className="text-primary">asy</span>
      </p>
      {children}
    </main>
  );
}

export default async function SignupPage() {
  const closed = await signupClosedAnswer((await headers()).get("host"));
  if (closed?.status === 404) notFound();
  if (closed) {
    return (
      <Frame>
        <div data-signup="closed" className="space-y-3 rounded-card border border-border bg-card p-6 text-card-foreground shadow-card">
          <h1 className="text-[1.375rem] font-semibold">{closed.body.code === "SIGNUPS_CLOSED" ? "Signups are closed right now" : "Signups are unavailable right now"}</h1>
          <p className="text-muted-foreground">{closed.body.error}</p>
          {closed.body.contact && (
            <Link href={closed.body.contact} className="inline-block font-medium text-primary underline-offset-4 hover:underline">
              Tell us about your store
            </Link>
          )}
        </div>
      </Frame>
    );
  }
  return (
    <Frame>
      <SignupFlow storeDomain={signupStoreDomain()} codeMinutes={Math.round(CODE_TTL_MS / 60000)} resendSeconds={Math.round(RESEND_GAP_MS / 1000)} />
    </Frame>
  );
}
