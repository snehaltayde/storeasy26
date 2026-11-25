import { NextResponse } from "next/server";
import { rateLimitAsync } from "@/lib/rate-limit";
import { storefrontHandler } from "@/lib/storefront-request";
import { tenantCfg, tenantShippingConfig } from "@/lib/tenant-context";
import { slog } from "@/lib/log";
import { pincodeAnswer } from "@/lib/pincode/index";
import { DEFAULT_TIME_ZONE } from "@/lib/delivery-estimate";

// Phase 8 line 1: GET /api/pincode?pin=560001 → the place (bundled India Post
// dataset, lib/pincode) and THIS store's public delivery facts for it: the
// estimate, cash on delivery, the free-shipping threshold. The store comes from
// the host (storefrontHandler). Node runtime: the dataset is a file. The log
// line never carries the pin.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = storefrontHandler(async (request) => {
  const limited = await rateLimitAsync(request, { name: "pincode", limit: 30 });
  if (limited) return limited;
  const answer = await pincodeAnswer(new URL(request.url).searchParams.get("pin"), {
    config: tenantShippingConfig(),
    timeZone: tenantCfg("timezone", null, DEFAULT_TIME_ZONE),
  });
  if (!answer.ok) return NextResponse.json({ error: answer.error, code: "BAD_PIN" }, { status: 400 });
  slog("pincode_lookup", { found: answer.found });
  const { ok, ...body } = answer;
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
});
