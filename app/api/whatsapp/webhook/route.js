import { NextResponse } from "next/server";
import { tenantHandler } from "@/lib/tenant-request";
import { slog } from "@/lib/log";
import { db } from "@/lib/db";
import { decryptJson } from "@/lib/platform/crypto";
import { revokePhone, timingSafeEqual } from "@/lib/messaging/consent";
import { STOP_WORDS, hubSignature } from "@/lib/messaging/whatsapp";

// Phase 9 line 3: Meta's WhatsApp webhook for this store (the host names the store).
//   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=… → 200 with
//        the challenge when the token matches the install's verify token
//        (constant time), else 403
//   POST X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body, keyed
//        with the install's app secret>, compared in constant time. A missing
//        or wrong signature, or no app secret → 401 and nothing changes.
//        An inbound text of STOP (or UNSUBSCRIBE) revokes every WhatsApp
//        consent for that number. Everything else is acknowledged and ignored.
//        A body over 256 KB → 413, before any signature work.
// Meta's docs (Webhooks, "Create a webhook endpoint"), read 2026-11-26.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function installSecrets() {
  const row = await db.selectFrom("plugin_installs").select(["secrets_enc", "status"]).where("plugin_id", "=", "whatsapp").where("status", "in", ["enabled", "disabled"]).executeTakeFirst();
  if (!row?.secrets_enc) return {};
  try {
    return await decryptJson(row.secrets_enc);
  } catch {
    return {};
  }
}

export const GET = tenantHandler(async (request) => {
  const q = new URL(request.url).searchParams;
  const { verify_token: want } = await installSecrets();
  if (q.get("hub.mode") !== "subscribe" || !want || !timingSafeEqual(String(q.get("hub.verify_token") ?? ""), String(want))) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  return new NextResponse(String(q.get("hub.challenge") ?? "").slice(0, 200), { status: 200, headers: { "content-type": "text/plain" } });
});

// Meta's notification bodies are small; anything bigger is refused before the HMAC
const MAX_BODY_BYTES = 256 * 1024;
const tooBig = () => NextResponse.json({ error: "body too large" }, { status: 413 });

// the raw body, read as a stream with a running limit (a chunked request with
// no content-length can't get past it) → string | null when over the limit
async function rawBody(request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export const POST = tenantHandler(async (request) => {
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) return tooBig();
  const raw = await rawBody(request);
  if (raw === null) return tooBig();
  const given = String(request.headers.get("x-hub-signature-256") ?? "");
  const { app_secret: appSecret } = await installSecrets();
  if (!appSecret || !given || !timingSafeEqual(await hubSignature(String(appSecret), raw), given)) {
    slog("wa_webhook_refused", { reason: !appSecret ? "no_secret" : !given ? "no_signature" : "bad_signature" });
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }
  let stopped = 0;
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      for (const m of Array.isArray(change?.value?.messages) ? change.value.messages : []) {
        const text = String(m?.text?.body ?? m?.button?.text ?? "").trim().toUpperCase();
        if (m?.from && STOP_WORDS.includes(text)) stopped += await revokePhone(`+${String(m.from).replace(/\D/g, "")}`, "whatsapp_stop");
      }
    }
  }
  if (stopped) slog("wa_stop_inbound", { revoked: stopped });
  return NextResponse.json({ ok: true });
});
