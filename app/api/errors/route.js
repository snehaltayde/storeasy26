import { NextResponse } from "next/server";
import { captureError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";

// Client-side error intake (Session 17). Tightly limited + size-capped — an
// error reporter must never become an abuse vector. Operational telemetry
// (not marketing tracking), so it is not consent-gated; no PII is accepted.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 8 * 1024;

export async function POST(request) {
  const limited = rateLimit(request, { name: "errors", limit: 10 });
  if (limited) return limited;

  const raw = await request.text();
  if (raw.length > MAX_BODY)
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { name, message, stack, url, digest } = body;
  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });

  const r = await captureError({
    source: "client",
    error: { name: String(name || "Error").slice(0, 100), message: String(message).slice(0, 500), stack: String(stack || "").slice(0, 2048) },
    url: url ? String(url).slice(0, 500) : null,
    digest: digest ? String(digest).slice(0, 100) : null,
  });
  return NextResponse.json({ ok: true, fingerprint: r.fingerprint }, { status: 202 });
}
