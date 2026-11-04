// P4-HARNESS: the writes of the phase 4 drill store (seed-design-documents.js
// --p4). Inside withTenant(design), after a fresh perf seed: the legacy
// writers the old consoles use (block, page, pairs, override, template and
// experiment writers), then one more release with createRelease. Kept here,
// with the drills, because the writer guard (scripts/test-writers.js) allows
// the old block and page writers only in fixture and drill code. Local
// harness databases only: the caller (withHarnessStore) refuses anything else.
// The plan and the constants come from the caller (seed-design-documents.js):
// importing that file from here would wait on its own top-level await.

const sixModules = (photo) =>
  Array.from({ length: 6 }, (_, i) => ({
    title: ["How to use", "Ingredients", "Lab report", "Taste notes", "Storage", "Who it is for"][i],
    html: i === 2 ? `<p>Tested by a third-party lab.</p><p><img src="/api/media/${photo}" alt="The lab report for this batch"></p>` : `<p>Module ${i + 1}: words the founder wrote for this product.</p>`,
  }));

// Inside withTenant(design), after a fresh perf seed. Legacy writers only.
export async function seedP4Content({ libsql, plan, P4_EXPERIMENT, P4_PAIRS_TITLE, P4_TEMPLATES }) {
  const one = async (sql, args = []) => (await libsql.execute({ sql, args })).rows[0] || {};
  const mode = (await one("SELECT mode FROM cms_state WHERE id = 1")).mode ?? "legacy";
  if (mode !== "legacy") throw new Error(`seedP4Content: the store is in ${mode} mode; --p4 needs the fresh perf seed's legacy store`);
  const { upsertPlacement, deletePlacement } = await import("../../../lib/cms/placements.js");
  const { setProductOverride } = await import("../../../lib/catalog-overrides.js");
  const { setBlock, upsertContentPage, deleteContentPage } = await import("../../../lib/cms/store.js");
  const { validateBlock } = await import("../../../lib/cms/validate.js");
  const { saveTemplate } = await import("../../../lib/cms/templates-store.js");
  const X = await import("../../../lib/experiments.js");

  // the module-only photo: its catalog uses move to a stand-in photo (catalog
  // rows, as a sync writes them), then the chosen product's module points at it
  for (const [table, col] of [["products", "featured_image"], ["product_images", "url"], ["variants", "image_url"], ["collections", "image"]]) {
    await libsql.execute({ sql: `UPDATE ${table} SET ${col} = replace(${col}, ?, ?) WHERE ${col} LIKE ?`, args: [plan.moduleOnlyPhoto, plan.standInPhoto, `%${plan.moduleOnlyPhoto}%`] });
  }
  await setProductOverride(plan.chosen.id, { modules: sixModules(plan.moduleOnlyPhoto), badge: "Bestseller" });

  // pairs: the chosen product's with its own title, one switched off, one
  // source with two, and the demo store's own pairs row removed (40 in all)
  const put = (p, over = {}) => upsertPlacement({ id: p.id, kind: p.kind, sourceProductId: p.sourceProductId, targetProductIds: p.targetProductIds, title: p.title, enabled: p.enabled !== false, position: p.position ?? 0, ...over });
  await put(plan.customPairs, { title: P4_PAIRS_TITLE });
  await put(plan.disabledPairs, { enabled: false });
  await put(plan.secondPairs);
  for (const r of (await libsql.execute("SELECT id FROM placements WHERE kind = 'pdp_pairs' AND id NOT LIKE 'pp-perf-%'")).rows) await deletePlacement(r.id);

  // template exceptions: the chosen product and the first pinned collection
  const st = validateBlock("surface_templates", { products: { [plan.chosen.id]: "editorial" }, collections: { [plan.pinned.id]: "sidebar" } });
  if (!st.ok) throw new Error(`seedP4Content: surface templates invalid: ${(st.errors || []).join(" · ")}`);
  await setBlock("surface_templates", st.value);

  // a page redirect: a journal post renamed the way the old console does it
  const row = await one("SELECT * FROM cms_pages WHERE slug = ?", [plan.renamedPost.from]);
  if (!row.slug) throw new Error(`seedP4Content: the perf fixture has no journal post "${plan.renamedPost.from}"`);
  await upsertContentPage({ slug: plan.renamedPost.to, title: row.title, description: row.description ?? "", sections: JSON.parse(row.sections || "[]"), enabled: row.enabled !== 0, effective_at: row.effective_at, family: row.family, window_start: row.window_start, window_end: row.window_end, redirect_from: plan.renamedPost.from });
  await deleteContentPage(plan.renamedPost.from);

  // two saved templates and a running hero experiment
  const templates = [];
  for (const t of P4_TEMPLATES) templates.push(await saveTemplate(structuredClone(t)));
  // the base demo seed already runs one hero experiment; start ours only when it doesn't
  let experiment = (await X.runningExperimentFor("hero"))?.slug ?? null;
  if (!experiment) {
    await X.upsertExperiment(structuredClone(P4_EXPERIMENT));
    await X.startExperiment(P4_EXPERIMENT.slug);
    experiment = P4_EXPERIMENT.slug;
  }

  // publish: one more version 3 release, through the old publish path
  const { createRelease } = await import("../../../lib/releases.js");
  const rel = await createRelease({ note: "P4-HARNESS drill store", actor: null });
  return { plan, release: rel.id, templates: templates.map((t) => t.id), experiment };
}
