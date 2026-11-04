import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { listBundles, upsertBundle, createBundle, setBundleEnabled, deleteBundle, bundleCompat } from "@/lib/bundles";
import { storeCurrency } from "@/lib/offers/catalog";
import { tenantHandler } from "@/lib/tenant-request";

// Bundles admin API (S46 / BE31 + SF18). Bundles ride the offers engine
// (priority-5 BUNDLE line offers) — this surface manages the curated rows
// and their compatibility gate. Enabling REFUSES while components are
// missing/sold out or the price doesn't save; nothing here touches money.
//   GET                      → bundles with live compatibility, each with
//                              usedOnHome (on the live home page)
//   POST {bundle:{…}}        → create/update (enable gated)
//   POST {create:{title, items:[{variantId gid, quantity}], bundle_price,
//                 description?, enable?, mustPass?}}
//                            → a new bundle with a derived slug (P5-BUNDLEREAD)
//   POST {check:{items, bundle_price}} → dry-run compatibility
// Every action that takes items wants picked variant GIDs: anything else is
// 422 "Pick the product again." with nothing read or written (P5-PANEL).
// GET and check also answer `currency` (the store's, for formatting) and the
// structured `reasons` (lib/commerce/bundle-words.js turns them into words).
// SLUG_TAKEN answers 409 and BUNDLE_INCOMPATIBLE 422, in plain words.
//   POST {enable:{id, enabled}}
//   POST {remove:{id}}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// P5-PANEL (deviation 3.10, OQ-F): a component is always a picked variant
// GID. A typed product handle is no longer looked up (it used to resolve to
// the product's first variant, a guess the founder could not see); the
// `bundle` and `check` actions refuse it, 422 "Pick the product again.",
// before anything is read or written, as `create` already did.
const VARIANT_GID = /^gid:\/\/[^/]+\/ProductVariant\/\S+$/;
const pickedOnly = (items) => (Array.isArray(items) ? items : []).every((i) => VARIANT_GID.test(String(i?.variantId || "")));
const pickAgain = () => NextResponse.json({ error: "Pick the product again.", code: "BAD_ITEM" }, { status: 422 });

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "offers.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  // each row carries usedOnHome (lib/bundles.js listBundles, P5-PANEL)
  return NextResponse.json({ ok: true, bundles: await listBundles(), currency: await storeCurrency() });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "offers.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  try {
    if (body.check) {
      if (!pickedOnly(body.check.items)) return pickAgain();
      const items = body.check.items;
      const c = await bundleCompat({ ...body.check, items });
      const compat = { ok: c.ok, problems: c.problems, components: c.components, componentsSum: c.componentsSum, saving: c.saving, state: c.state, reasons: c.reasons };
      return NextResponse.json({ ok: true, compat, items, currency: await storeCurrency() });
    }
    if (body.create) {
      const c = body.create;
      const items = Array.isArray(c.items) ? c.items : [];
      // only picked variants: a typed handle is never guessed at here
      if (!pickedOnly(items)) return pickAgain();
      const saved = await createBundle({ title: c.title, items, bundle_price: c.bundle_price, description: c.description, enable: !!c.enable, mustPass: !!c.mustPass });
      await audit({ actor: auth.actor, action: "offers.write", resource: `bundle:${saved.slug}`, diff: { enabled: !!saved.enabled, components: items.length } });
      const { compat, ...bundle } = saved;
      return NextResponse.json({ ok: true, bundle, compat: { state: compat.state, reasons: compat.reasons }, currency: await storeCurrency() });
    }
    if (body.bundle) {
      const b = body.bundle;
      if (!pickedOnly(b.items)) return pickAgain();
      const items = b.items;
      // P5-BUNDLEREAD: enable and description only when sent, so an edit
      // keeps a live bundle live and its description as it was
      const saved = await upsertBundle({ id: b.id || null, slug: b.slug, title: b.title, description: "description" in b ? b.description : undefined, items, bundle_price: b.bundle_price, enable: "enable" in b ? !!b.enable : undefined });
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
    if (e?.code === "SLUG_TAKEN") return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
    if (e?.code === "BUNDLE_INCOMPATIBLE" || e?.code === "BUNDLE_INVALID") return NextResponse.json({ error: String(e.message).slice(0, 300), code: e.code, state: e.state, reasons: e.reasons || [], problems: e.problems || [] }, { status: 422 });
    if (e?.problems) return NextResponse.json({ error: String(e.message).slice(0, 300), problems: e.problems }, { status: 422 }); // enabling refused, with why
    const infra = infraResponse(e, { route: "admin/bundles" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});
