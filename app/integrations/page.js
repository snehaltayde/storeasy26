import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isPlatformSiteHost } from "@/lib/platform-site";

// Integration directory (S44 / MK05) — STATUS-ACCURATE: "live" means shipped
// and verified in production code today; "optional" means supported when the
// merchant configures it; nothing here is aspirational.
export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

const INTEGRATIONS = [
  { name: "Shopify", role: "Catalog, inventory, orders & fulfilment system of record", status: "live", detail: "Per-store app connection, webhook-driven sync with generation-safe pruning, draft-order push with idempotent retries." },
  { name: "Razorpay", role: "Shopper payments (per store)", status: "live", detail: "Checkout + webhooks with HMAC verification and replay-safe capture; COD alongside." },
  { name: "Razorpay Subscriptions", role: "Platform billing", status: "live", detail: "Versioned plans, webhook-reconciled entitlements, grace periods." },
  { name: "Google Analytics 4", role: "Analytics (consent-gated)", status: "live", detail: "Client tag + server Measurement Protocol, both behind the shopper's explicit consent." },
  { name: "Meta Pixel + CAPI", role: "Marketing events (consent-gated)", status: "live", detail: "Separate marketing consent; withdrawal stops client and server forwarding." },
  { name: "Resend", role: "Transactional email", status: "optional", detail: "Durable notification queue ships now; sends activate when a mail key is configured — until then everything is honestly labeled as not sent." },
  { name: "Typesense", role: "Search upgrade", status: "optional", detail: "SQL search is the supported engine and works out of the box; Typesense adds typo-tolerance when configured." },
];

const CHIP = { live: "bg-lime-100 text-lime-700", optional: "bg-zinc-100 text-zinc-600" };

export default async function IntegrationsPage() {
  if (!isPlatformSiteHost((await headers()).get("host"))) notFound();
  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Integrations</h1>
      <p className="mt-3 max-w-xl text-zinc-600">
        Status-accurate: <span className="font-semibold">live</span> is shipped and verified today;{" "}
        <span className="font-semibold">optional</span> works when you configure it. No roadmap decoration.
      </p>
      <ul className="mt-10 space-y-3">
        {INTEGRATIONS.map((i) => (
          <li key={i.name} className="rounded-2xl border border-zinc-200 p-5">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-bold">{i.name}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${CHIP[i.status]}`}>{i.status}</span>
              <span className="text-sm text-zinc-500">· {i.role}</span>
            </p>
            <p className="mt-1.5 text-sm text-zinc-600">{i.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
