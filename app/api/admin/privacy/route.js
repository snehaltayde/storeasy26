import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { listPrivacyRequests } from "@/lib/privacy";
import { db } from "@/lib/db";
import { CONSENT_VERSION } from "@/lib/track/names";
import { tenantHandler } from "@/lib/tenant-request";

// Merchant privacy surface (S43 / MC25): consent configuration summary,
// privacy request tracking (the S33 webhook-driven lifecycle), redaction
// stats. Read-only — executing a redaction is the S33 webhook flow or the
// operator's privacy ops (OP11), both audited.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "settings.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const [requests, redacted, consentStats] = await Promise.all([
    listPrivacyRequests({ limit: 50 }).catch(() => []),
    db
      .selectFrom("orders")
      .select(({ fn }) => fn.countAll().as("n"))
      .where("redacted_at", "is not", null)
      .executeTakeFirst()
      .catch(() => ({ n: 0 })),
    db
      .selectFrom("events")
      .select(["consent"])
      .select(({ fn }) => fn.countAll().as("n"))
      .groupBy("consent")
      .execute()
      .catch(() => []),
  ]);

  return NextResponse.json({
    ok: true,
    consent: {
      version: CONSENT_VERSION,
      purposes: [
        { id: "analytics", label: "Analytics (GA4)", basis: "opt-in via the consent banner; versioned; withdrawal stops client AND server forwarding" },
        { id: "marketing", label: "Marketing (Meta)", basis: "separate opt-in; same discipline" },
      ],
      note: "Events are recorded only with consent; each event stores the consent snapshot it was collected under.",
    },
    retention: {
      orders: "kept for the legal/accounting record; PII fields are redacted on request (money rows retained)",
      events: "redaction removes identifiers; raw client IPs are never stored in payloads",
      media: "merchant-managed (Media tab delete)",
    },
    requests,
    redacted_orders: Number(redacted?.n ?? 0),
    consent_snapshots: consentStats.map((r) => ({ consent: r.consent, events: Number(r.n) })),
  });
});
