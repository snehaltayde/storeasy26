import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { sameOrigin } from "@/lib/origin-check";
import { getTenant, patchTenant } from "@/lib/platform/control.js";
import { createInvite } from "@/lib/platform/identity.js";
import { sendMail } from "@/lib/mail.js";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { randomBytes } from "node:crypto";
import { ROLES } from "@/lib/platform/authz.js";

// Merchant hand-off (S51): the operator's way to give a store's owner access —
// previously the console password appeared ONCE at provisioning and there was
// no in-product way to share or recover access at all.
//   POST {action:"invite", email, role?}  → single-use 7-day acceptance link
//     (the real flow: the merchant registers email+password themselves; mail
//     goes out when a provider is configured, and the link is returned either
//     way so the operator can hand it over on their own channel).
//   POST {action:"rotate_password"}       → new bootstrap console password,
//     returned once (replaces the provisioning-time one; old one stops working).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (error, status) => NextResponse.json({ ok: false, error }, { status });

const consoleUrl = (tenant) => {
  const host = tenant.domains?.[0];
  if (!host) return null;
  const proto = /(^|\.)localhost(:|$)|^127\.0\.0\.1/.test(host) ? "http" : "https";
  return `${proto}://${host}`;
};

export async function POST(request, { params }) {
  if (!sameOrigin(request)) return deny("Cross-origin request rejected", 403);
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return deny("Unauthorized", 401);
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) return deny("Not found", 404);
  const body = await request.json().catch(() => ({}));

  if (body.action === "rotate_password") {
    const password = randomBytes(9).toString("base64url");
    await patchTenant(id, { secrets: { admin_password: password } });
    slog("tenant_console_password_rotated", { tenant: id });
    await audit({ actor: { kind: "operator", id: "operator" }, action: "tenant.update", tenantId: id, diff: { console_password_rotated: true } });
    return NextResponse.json({ ok: true, password, loginUrl: consoleUrl(tenant) ? `${consoleUrl(tenant)}/admin/login` : null });
  }

  if (body.action === "invite") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return deny("A valid email is required", 400);
    const role = ROLES.includes(body.role) ? body.role : "owner";
    const base = consoleUrl(tenant);
    if (!base) return deny("The tenant has no domains yet — add one first (More → Edit details).", 409);
    const { token, expiresAt } = await createInvite({ email, tenantId: id, role, invitedBy: "operator" });
    const link = `${base}/admin/accept-invite?token=${token}`;
    const mail = await sendMail({
      to: email,
      subject: `You're invited to the ${tenant.name} store console`,
      text: `You've been invited to the ${tenant.name} store console as ${role}.\n\nAccept here (valid 7 days, single use):\n${link}\n`,
    });
    slog("tenant_handoff_invite", { tenant: id, role, mail_mock: !!mail.mock });
    await audit({ actor: { kind: "operator", id: "operator" }, action: "team.invite_created", tenantId: id, diff: { role, via: "platform-handoff" } });
    return NextResponse.json({ ok: true, link, expiresAt, role, mail: { mock: !!mail.mock, ok: mail.ok !== false, error: mail.error || null } });
  }

  return deny('action must be "invite" or "rotate_password"', 400);
}
