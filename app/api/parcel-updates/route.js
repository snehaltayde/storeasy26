import { NextResponse, after } from "next/server";
import { tenantHandler } from "@/lib/tenant-request";
import { rateLimitAsync } from "@/lib/rate-limit";
import { tenantId } from "@/lib/tenant-context";
import { enqueueJob } from "@/lib/platform/jobs";
import { runJobById } from "@/lib/platform/worker";
import { sha256Hex } from "@/lib/platform/sessions";
import { slog } from "@/lib/log";
import { checkWebhookKey, orderIdForAwb } from "@/lib/couriers/tracking";
import { AWB_RE } from "@/lib/couriers/normalize";

// Phase 9 line 4: Shiprocket's tracking webhook, POST /api/parcel-updates on
// the store's own host (the store comes from the host). Shiprocket's rule: the
// address may not contain "shiprocket", "kartrocket", "sr" or "kr", and the
// only proof is the x-api-key header (the body is not signed). So:
//   - the key is compared in constant time with this store's own hash
//     (lib/shipments.js checkWebhookKey); missing, wrong, another store's or
//     an old key past its overlap → 401, nothing read
//   - a body over 64 KB → 413
//   - the body is only a hint: it names an AWB, and a courier_refetch job asks
//     Shiprocket for that AWB; Shiprocket's answer is what gets written
//   - an AWB this store doesn't know is logged and ignored (still 200)
// It answers 200 fast; the refetch runs after the answer.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const NO_STORE = { headers: { "cache-control": "no-store" } };
const OK = () => NextResponse.json({ ok: true }, NO_STORE);
const jobTenant = () => (tenantId() === "_default" ? null : tenantId());

async function readCapped(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.length;
    if (read > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export const POST = tenantHandler(async (request) => {
  const limited = await rateLimitAsync(request, { name: "parcel-updates", limit: 300 });
  if (limited) return limited;
  if (!(await checkWebhookKey(request.headers.get("x-api-key")))) {
    slog("courier_webhook_refused", {});
    return NextResponse.json({ error: "Not allowed.", code: "BAD_KEY" }, { status: 401 });
  }
  const text = await readCapped(request);
  if (text == null) return NextResponse.json({ error: "Too large.", code: "TOO_LARGE" }, { status: 413 });
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const awb = typeof body?.awb === "string" || typeof body?.awb === "number" ? String(body.awb).trim() : "";
  if (!AWB_RE.test(awb)) return OK(); // Shiprocket's own test call, or nothing usable
  if (!(await orderIdForAwb(awb))) {
    slog("courier_unknown_awb", {});
    return OK();
  }
  // one refetch per distinct update (Shiprocket's retries of the same update collapse)
  const stamp = (await sha256Hex(`${awb}|${String(body.current_status ?? "")}|${String(body.current_timestamp ?? "")}`)).slice(0, 16);
  const job = await enqueueJob({ type: "courier_refetch", tenantId: jobTenant(), payload: { awb }, idempotencyKey: `courier_refetch:${tenantId()}:${awb}:${stamp}`, maxAttempts: 3 });
  if (job?.id && !job.existed) after(() => runJobById(job.id, { budgetMs: 10_000 }).catch(() => {}));
  return OK();
});
