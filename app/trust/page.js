import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isPlatformSiteHost } from "@/lib/platform-site";

// Trust & security (S44 / MK07) — DEPLOYED CONTROLS ONLY. Each item names
// behavior that exists in shipped code with automated tests; nothing here is
// a policy intention.
export const metadata = { title: "Trust & security" };
export const dynamic = "force-dynamic";

const CONTROLS = [
  { title: "One database per store", body: "Every store's commerce data lives in its own isolated database. Cross-store reads aren't a permission setting — they're structurally impossible, and our test suite proves it with overlapping fixtures." },
  { title: "Fail-closed tenancy", body: "An unknown or suspended host resolves to nothing — never to another store's content. Control-plane outages serve a bounded stale snapshot, then fail closed." },
  { title: "Encrypted secrets, rotatable", body: "Store credentials live in versioned encrypted envelopes with key rotation (dual-read, single-write) and masked read models — secret values never reach a browser." },
  { title: "Individual accounts, roles, audit", body: "Owner/admin/staff/support roles enforced server-side on every privileged route; sessions are revocable instantly; every privileged action lands in an append-only, redacted audit log." },
  { title: "Consent-first analytics", body: "Behavioural events exist only with the shopper's explicit, purpose-split consent (analytics vs marketing). Withdrawal stops client tags and server forwarding. Each event stores the consent it was collected under." },
  { title: "Privacy lifecycle", body: "Shopify privacy webhooks (data request, customer redact, shop redact) are processed through a durable queue; redaction scrubs PII while retaining the money record, and every request is tracked to completion." },
  { title: "Webhook & payment integrity", body: "Every webhook is HMAC-verified and persisted before acknowledgement; replays are idempotent — a duplicated payment event can never move money twice (that exact scenario is an automated test)." },
  { title: "Releases with validation and rollback", body: "Storefront changes publish as immutable, content-hashed releases after validation (dead links, contrast); rollback is atomic and preserves drafts." },
  { title: "Backups with rehearsed restores", body: "Point-in-time restore drills run against real store databases with integrity checks (row counts, ledger checksums, order-total sums) — restore is a practiced procedure, not a hope." },
  { title: "Never hard-shut-down", body: "Billing trouble degrades gracefully: a grace period with full service, then checkout pauses with honest shopper copy while browsing and order lookups stay live." },
];

export default async function TrustPage() {
  if (!isPlatformSiteHost((await headers()).get("host"))) notFound();
  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Trust & security</h1>
      <p className="mt-3 max-w-xl text-zinc-600">
        Everything on this page is a deployed control with automated tests behind it — 406 checks run before
        any change to the platform ships. If it isn&rsquo;t built, it isn&rsquo;t listed.
      </p>
      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {CONTROLS.map((c) => (
          <div key={c.title} className="rounded-2xl border border-zinc-200 p-5">
            <h2 className="font-bold">{c.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-600">{c.body}</p>
          </div>
        ))}
      </div>
      <p className="mt-8 text-xs text-zinc-400">
        Known limits, stated plainly: the platform runs on Vercel + Turso (their compliance applies), formal
        certifications (SOC 2 / ISO 27001) are not held, and payment card data never touches us — it goes to
        Razorpay directly.
      </p>
    </div>
  );
}
