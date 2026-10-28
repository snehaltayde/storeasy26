import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { db } from "@/lib/db";
import { listBundles, upsertBundle, setBundleEnabled, deleteBundle, checkBundleCompatibility } from "@/lib/bundles";
import { tenantHandler } from "@/lib/tenant-request";

// Bundles admin API (S46 / BE31 + SF18). Bundles ride the offers engine
// (priority-5 BUNDLE line offers) — this surface manages the curated rows
// and their compatibility gate. Enabling REFUSES while components are
// missing/sold out or the price doesn't save; nothing here touches money.
//   GET                      → bundles with live compatibility
//   POST {bundle:{…}}        → create/update (enable gated)
//   POST {check:{items, bundle_price}} → dry-run compatibility
//   POST {enable:{id, enabled}}
//   POST {remove:{id}}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Console convenience: a component may name a product HANDLE instead of a
// variant GID — resolved here to the product's first variant. Ambiguity is
// honest: a multi-variant product typed by handle resolves to variant #1,
// which the compatibility echo then shows by name for the merchant to check.
async function resolveItems(items) {
  const out = [];
  for (const c of Array.isArray(items) ? items : []) {
    const key = String(c.variantId || "").trim();
    if (key && !key.startsWith("gid://")) {
      const p = await db.selectFrom("products").select(["id"]).where("handle", "=", key).executeTakeFirst();
      const v = p ? await db.selectFrom("variants").select(["id"]).where("product_id", "=", p.id).orderBy("position", "asc").executeTakeFirst() : null;
      out.push({ ...c, variantId: v?.id || key });
    } else {
      out.push(c);
    }
  }
  return out;
}

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "offers.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ ok: true, bundles: await listBundles() });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "offers.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  try {
    if (body.check) {
      const items = await resolveItems(body.check.items);
      return NextResponse.json({ ok: true, compat: await checkBundleCompatibility({ ...body.check, items }), items });
    }
    if (body.bundle) {
      const b = body.bundle;
      const items = await resolveItems(b.items);
      const saved = await upsertBundle({ id: b.id || null, slug: b.slug, title: b.title, description: b.description, items, bundle_price: b.bundle_price, enable: !!b.enable });
      await audit({ actor: auth.actor, action: "offers.write", resource: `bundle:${saved.slug}`, diff: { enabled: !!saved.enabled, components: (b.items || []).length } });
      return NextResponse.json({ ok: true, bundle: saved });
    }
    if (body.enable) {
      const r = await setBundleEnabled(String(body.enable.id || ""), !!body.enable.enabled);
      await audit({ actor: auth.actor, action: "offers.write", resource: `bundle:${r.id}`, diff: { enabled: !!r.enabled } });
      return NextResponse.json({ ok: true, ...r });
    }
    if (body.remove) {
      await deleteBundle(String(body.remove.id || ""));
      await audit({ actor: auth.actor, action: "offers.write", resource: `bundle:${body.remove.id}`, diff: { removed: true } });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300), ...(e.problems ? { problems: e.problems } : {}) }, { status: 422 });
  }
});
