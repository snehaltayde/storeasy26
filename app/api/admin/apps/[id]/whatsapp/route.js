import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { tenantHandler } from "@/lib/tenant-request";
import { db } from "@/lib/db";
import { appErrorAnswer, getInstall } from "@/lib/plugins/installs";
import { redactsPii } from "@/lib/admin/order-view";
import { maskPhone } from "@/lib/checkout/cod-otp";
import { PHONE_DAY_MAX, PHONE_WEEK_MAX, QUIET, STORE_DAY_DEFAULT } from "@/lib/messaging/caps";
import { WhatsAppError, VARS, approveTemplate, connection, listTemplates, saveTemplate } from "@/lib/messaging/whatsapp";
import { delayHours } from "@/lib/plugins/first-party/whatsapp/sweep";

// The WhatsApp card on the app's page (Phase 9 line 3). [id] is the
// WhatsApp install's id (pin_…); any other app → 404.
//   GET  apps.read → { ok, connection, templates, vars, caps, log }
//        log: the last 50 WhatsApp messages (kind, phone, status, class, time;
//        never the text). Phones are masked for support.
//   POST apps.manage, one of
//        { template: { kind, body?, provider_template?, language? } } (back to draft)
//        | { approve: "<kind>" }
//   Caps, delay and secrets are the app's own settings (apps/[id] POST).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });
const NOT_FOUND = { error: "This app isn't installed on your store. It may have been uninstalled.", code: "NOT_FOUND" };
const failure = (e) => {
  if (e instanceof WhatsAppError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  const f = appErrorAnswer(e, "admin/apps/[id]/whatsapp");
  return NextResponse.json(f.body, { status: f.status });
};

async function whatsappInstall(id) {
  const found = await getInstall(String(id || ""));
  return found?.install?.pluginId === "whatsapp" && found.install.status !== "uninstalled" ? found.install : null;
}

async function cardView(install, role) {
  const mask = redactsPii(role);
  const rows = await db.selectFrom("notifications").select(["id", "type", "recipient", "status", "consent_class", "created_at", "sent_at"]).where("type", "like", "whatsapp_%").orderBy("created_at", "desc").limit(50).execute();
  const dailyCap = Number.isInteger(install.settings?.daily_cap) ? install.settings.daily_cap : STORE_DAY_DEFAULT;
  return {
    ok: true,
    connection: connection({ settings: install.settings, secretsSet: install.secretsSet }),
    templates: await listTemplates(),
    vars: VARS,
    caps: { delayHours: delayHours(install.settings), dailyCap, perPhoneDay: PHONE_DAY_MAX, perPhoneWeek: PHONE_WEEK_MAX, quietFrom: QUIET.from, quietTo: QUIET.to },
    log: rows.map((r) => ({
      id: String(r.id),
      kind: String(r.type).replace(/^whatsapp_/, ""),
      to: r.recipient === "redacted" ? "removed" : mask ? maskPhone(r.recipient) : String(r.recipient),
      status: String(r.status),
      marketing: r.consent_class === "marketing",
      at: String(r.sent_at ?? r.created_at),
    })),
  };
}

export const GET = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "apps.read");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  try {
    const install = await whatsappInstall(id);
    if (!install) return NextResponse.json(NOT_FOUND, { status: 404 });
    return NextResponse.json(await cardView(install, auth.actor.role));
  } catch (e) {
    return failure(e);
  }
});

export const POST = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "apps.manage");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const asked = ["template", "approve"].filter((k) => body && body[k] !== undefined && body[k] !== null);
  if (asked.length !== 1) return NextResponse.json({ error: "Choose one thing to change.", code: "BAD_REQUEST" }, { status: 400 });
  try {
    const install = await whatsappInstall(id);
    if (!install) return NextResponse.json(NOT_FOUND, { status: 404 });
    const opts = { actor: auth.actor, installId: install.id };
    if (asked[0] === "template") {
      const t = typeof body.template === "object" ? body.template : {};
      await saveTemplate(String(t.kind ?? ""), { body: t.body, provider_template: t.provider_template, language: t.language }, opts);
    } else await approveTemplate(String(body.approve), opts);
    return NextResponse.json(await cardView(install, auth.actor.role));
  } catch (e) {
    return failure(e);
  }
});
