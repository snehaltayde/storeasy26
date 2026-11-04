// P4-MAPPER (MIG-01, MIG-02): the dry-run report, in plain words a founder
// can act on, with the developer detail below a "Details" line. P4-CUTOVER and
// P4-REVERSE add to this file later.
//
//   dryRun({ storeOpen, platform })  P4-CUTOVER: the whole dry run, in the
//                                    tenant's context: the mapping, the data
//                                    check over routesFor plus entityRoutesFor
//                                    (once each), the product and collection
//                                    names, the report and its digest. The
//                                    command's dry run and the cutover's
//                                    digest precondition both call this, so
//                                    the two digests are the same by
//                                    construction (P4-FIX1 review)
//   buildReport(mapped, dataCheck, { routes, names })
//                                    the full report, as plain JSON (what
//                                    --json prints, and what the digest hashes).
//                                    names: { products: {id: title},
//                                    collections: {handle: title} } (P4-CUTOVER:
//                                    entity changes are named by product)
//   renderText(report, digest)       the default output: the verdict line and
//                                    the plain sections, in this order, then
//                                    "Details", then the digest
//   reportDigest(report)             sha256 of the report's canonical JSON:
//                                    the same whatever the output format
//
// P4-CUTOVER adds the move's own words (the plain layout again, then Details):
//   renderCutoverText(report)        what the move did, or why it stopped
//   renderStatusText(status, { tenant, now, command })
//                                    --status: the mode, the step, when it
//                                    started, how long, what to run next
//                                    (command(flag): the command line, given
//                                    by scripts/migrate-documents.js)
//   renderRefusal(refusal)           one refusal of the move, in plain words
//
// Plain sections (above "Details"): no table names, no error codes, no ids,
// no statement counts. scripts/test-migrate-map.js checks that.
import { stableStringify, documentType } from "../registry/index.js";
import { livePath } from "../documents/paths.js";
import { ROLES, roleAllows } from "../platform/authz.js";
import { sha256Hex } from "./ids.js";
import { mapTenant } from "./map.js";
import { dataCheck, entityRoutesFor, routesFor, entityIdsOf } from "./check.js";
import { libsql } from "../db.js";
import { notMigratedYet } from "../schema-shape.js";
import { restoreForRun } from "./backfill.js";

export const SECTION_TITLES = Object.freeze([
  "What shoppers will see change",
  "Unpublished changes that will carry over as drafts",
  "Drafts kept as older versions",
  "Things the new editor will flag",
  "Old addresses that couldn't be matched",
  "Saved templates",
  "Team access that changes",
]);
export const DETAILS_LINE = "Details";

const SINGLETON_NAMES = {
  announcement: "The announcement bar",
  header: "The header menu",
  footer: "The footer menu",
  design: "Your brand colours and look",
  home: "The home page",
  collections_index: "The collections page",
  product_layout: "The product page layout",
  collection_layout: "The collection page layout",
  cart: "The cart offer",
  journal_index: "The journal list",
};

// A document, in founder words.
export function plainName(d) {
  if (!d) return "A page";
  if (Object.hasOwn(SINGLETON_NAMES, d.type)) return SINGLETON_NAMES[d.type];
  const t = documentType(d.type);
  if (t?.route) {
    const what = d.type === "journal" ? "The journal post" : d.type === "campaign" ? "The campaign page" : "The page";
    return `${what} “${d.label}” (${d.path || livePath(d.type, { slug: d.slug })})`;
  }
  return t?.label || "A part of your store";
}

const ROLE_WORDS = { owner: "Owners", admin: "Admins", staff: "Staff", support: "Support" };

// Who could change the cart offer before (the Upsells screen: upsells.write)
// and after (the new editor: storefront.write, then storefront.publish to put
// it live), from the role table itself.
export function cartAccessChanges() {
  const out = [];
  for (const role of ROLES) {
    const before = roleAllows(role, "upsells.write");
    const edit = roleAllows(role, "storefront.write");
    const publish = roleAllows(role, "storefront.publish");
    if (!before) continue;
    const who = ROLE_WORDS[role] || role;
    if (edit && !publish) out.push({ role, text: `${who} can still change the cart offer, but an owner or admin has to publish it before shoppers see it.` });
    else if (!edit) out.push({ role, text: `${who} can no longer change the cart offer.` });
  }
  return out;
}

// What a getter's route is, in founder words (for "What shoppers will see change").
// P4-CUTOVER: the product and collection getters name the product or
// collection (names from dryRun), never "a part of your store".
const productName = (id, names) => {
  const t = names?.products?.[id];
  return typeof t === "string" && t.trim() ? `the product “${t.trim()}”` : "a product";
};
const collectionName = (key, names) => {
  const t = names?.collections?.[key];
  return typeof t === "string" && t.trim() ? `the collection “${t.trim()}”` : "a collection";
};
function routeName(fn, args, docs, names = null) {
  const bySlug = (slug) => docs.find((d) => d.slug === slug);
  switch (fn) {
    case "resolvedProductOverride":
      return `the extra sections and badge on ${productName(args[0], names)}`;
    case "resolvedPdpPairs":
      return `the products shown with ${productName(args[0], names)}`;
    case "resolvedCollectionPins":
      return `the pinned products on ${collectionName(args[0], names)}`;
    case "resolvedAnnouncement":
      return "the announcement bar";
    case "resolvedHero":
    case "resolvedHomeSections":
    case "resolvedHomePage":
      return "the home page";
    case "resolvedNav":
      return args[0] === "footer" ? "the footer menu" : "the header menu";
    case "resolvedCollectionsIndex":
      return "the collections page";
    case "resolvedPdpExtras":
      return "the extra sections on every product page";
    case "resolvedContentPage": {
      const d = bySlug(args[0]);
      return d ? `the page ${d.path}` : `the address /${args[0]}`;
    }
    case "resolvedContentPageList":
      return "the list of pages in the footer, the sitemap and the checkout";
    case "resolvedJournalEntries":
      return "the journal list";
    case "resolvedBrand":
    case "resolvedTheme":
      return "your brand colours and look";
    case "resolvedSurfaceTemplates":
      return "the page layouts";
    case "resolvedSurfaceTemplateFor":
      if (args?.[1] != null && (args[0] === "pdp" || args[0] === "product")) return `the page layout of ${productName(args[1], names)}`;
      if (args?.[1] != null && args[0] === "collection") return `the page layout of ${collectionName(args[1], names)}`;
      return "the page layouts";
    case "resolvedCartUpsell":
      return "the cart offer";
    case "resolvedSlugRedirect":
      return `the old address /${args[0]}`;
    default:
      return "a part of your store";
  }
}

const SUPPORT = "Storeasy support will look at this with you before your store moves.";

// One refusal, as a thing to fix: { what, where }.
function refusalFix(r, facts) {
  const docName = (id) => plainName(facts.documents.find((d) => d.id === id));
  switch (r.code) {
    case "NEEDS_FLAG":
      return {
        what: "Your store has never been published, so we need to know whether shoppers can already see it.",
        where: "Run the check again with --store-open if shoppers can see your store today, or --not-launched if it isn't open yet.",
      };
    case "PENDING_SCHEDULE":
      return { what: "A release is scheduled to go live later. It would put old content back over the moved store.", where: "Storefront > Releases: publish it now or cancel it, then run the check again." };
    case "LIVE_READ_ERROR":
    case "UNKNOWN_MODE":
      return { what: "Your live store content can't be read right now.", where: SUPPORT };
    case "LIVE_V4_ON_LEGACY":
      return { what: "Your live store is in a state we don't expect.", where: SUPPORT };
    case "ALREADY_DOCUMENTS":
      return { what: "Your store already uses the new editor. There is nothing to move.", where: "Nothing to do." };
    case "MIGRATING":
      return { what: "Your store is being moved right now.", where: "Wait for the move to finish, or ask Storeasy support for its status." };
    case "APPROVALS_IN_USE":
      return { what: "Your store uses publish approvals, which the new editor doesn't support yet.", where: "Nothing to change on your side: this waits for a Storeasy update." };
    case "AGENCY_ACCESS":
      return { what: "An agency has access to your store, which the new editor doesn't support yet.", where: "Settings > Team: remove the agency's access, or wait for the Storeasy update." };
    case "AGENCY_UNCHECKED":
      return { what: "We couldn't check whether an agency has access to your store.", where: "Run the check again. If it keeps happening, ask Storeasy support." };
    case "NO_EDITOR":
      return { what: `${SINGLETON_NAMES[r.type] || "Part of your store"} has no editor in the new console yet, so it can't move.`, where: "Nothing to change on your side: this waits for a Storeasy update." };
    case "ENTITY_CONTENT_NOT_MOVABLE":
      return {
        what: "Your product and collection extras (product sections, badges, product pairings, pinned products, per-product layouts) can't be moved yet.",
        where: "Nothing to change on your side: Storeasy is finishing this part.",
      };
    case "SLUG_COLLISION":
      return {
        what: `Two pages want the address /${r.slug}: ${docName(r.mapped)} and a page made in the new editor.`,
        where: "In the new editor's pages, change the address of the newer page or delete it, then run the check again.",
      };
    default:
      return { what: "Something stops the move.", where: SUPPORT };
  }
}

const pluralize = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/**
 * The full report (plain JSON). `mapped` is map.js mapTenant's (or mapLegacy's)
 * output; `check` is check.js dataCheck's answer.
 */
export const NOT_CHECKED = "Not checked: fix the things above first.";

export function buildReport(mapped, check = null, { routes = null, names = null } = {}) {
  const f = mapped.report;
  // P4-FIX1: "Nothing." under "What shoppers will see change" only when the
  // comparison ran (or there is nothing published to compare: a store that
  // isn't open yet). A refused store, or no comparison at all, is "not checked".
  const checked = check?.ran === true || mapped.state.published === "none";
  const docs = f.documents;
  const fixes = [];
  for (const r of f.refusals) fixes.push({ kind: "refusal", code: r.code, ...refusalFix(r, f) });

  // what shoppers will see change: every data-check difference, by name
  const changes = [];
  const seenChange = new Set();
  const addChange = (name, text, expected = false) => {
    if (seenChange.has(name)) return;
    seenChange.add(name);
    changes.push({ name, text, expected });
  };
  const capital = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;
  if (mapped.state.published === "none") addChange("your store", "Your store stays closed to shoppers until your first publish in the new editor (you said it isn't open yet).", true);
  // P4-CUTOVER (from the P4-OVL07 review): what the new product page leaves
  // out that the old one shows, by product (the published side only: that is
  // what shoppers see today)
  const dropped = new Map();
  for (const x of mapped.entities?.holds?.dropped ?? []) {
    if (x.side !== "published" || !x.product) continue;
    const e = dropped.get(x.product) ?? { modules: 0, badge: false };
    if (x.what === "module") e.modules++;
    if (x.what === "badge") e.badge = true;
    dropped.set(x.product, e);
  }
  for (const d of check?.differences ?? []) {
    const name = routeName(d.fn, d.args, docs, names);
    const lost = d.fn === "resolvedProductOverride" ? dropped.get(d.args[0]) : null;
    if (d.fn === "resolvedSlugRedirect" && typeof d.legacy?.ok === "string") addChange(name, `${capital(name)} would stop sending shoppers to /${d.legacy.ok}.`);
    else if (lost) {
      const why = [
        lost.modules ? `${pluralize(lost.modules, "extra section has", "extra sections have")} no title or no text` : null,
        lost.badge ? "the badge is only spaces" : null,
      ].filter(Boolean);
      addChange(name, `${capital(name)} would change after the move: ${why.join(", and ")}, so the new product page leaves ${lost.modules + (lost.badge ? 1 : 0) === 1 ? "it" : "them"} out. Fill in or remove ${lost.modules + (lost.badge ? 1 : 0) === 1 ? "it" : "them"} in Catalog first.`);
    } else addChange(name, `${capital(name)} would look different after the move.`);
  }
  const unexpected = changes.filter((c) => !c.expected);
  if (unexpected.length) fixes.push({ kind: "shoppers", what: `Shoppers would see ${pluralize(unexpected.length, "change", "changes")} (listed below).`, where: SUPPORT });
  if (!checked && !f.refusals.length) fixes.push({ kind: "check", what: "The comparison with your live store couldn't run.", where: SUPPORT });

  // unmatched old addresses (the live side's are a shopper change too)
  const unmatched = f.unresolvedRedirects.map((r) => ({
    from: r.from_slug,
    to: r.to_slug,
    live: r.side === "published",
    text: `/${r.from_slug} sends shoppers to /${r.to_slug}, which isn't a page stored in your store.`,
  }));
  if (unmatched.length)
    fixes.push({
      kind: "addresses",
      what: `${pluralize(unmatched.length, "old address points", "old addresses point")} to a page that isn't stored in your store (listed below).`,
      where: "Storefront > Pages: create the page at that address, or ask Storeasy support to remove the old address.",
    });

  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const carried = docs
    .filter((d) => d.dirty)
    .map((d) => ({ name: plainName(d), neverPublished: d.neverPublished, text: d.neverPublished ? `${plainName(d)} (never published)` : plainName(d) }));
  // draft changes a document can't hold: said, never dropped quietly
  for (const n of f.notes) {
    const d = docs.find((x) => x.id === n.document);
    if (!d) continue;
    if (n.code === "PAGE_DELETED_IN_DRAFTS")
      carried.push({ name: plainName(d), text: `${plainName(d)}: you deleted it in your drafts, but it is still live. After the move it stays live until you take it offline in the new editor.` });
    if (n.code === "DRAFT_REMOVAL_NOT_CARRIED")
      carried.push({ name: plainName(d), text: `${plainName(d)}: your drafts switch it back to the automatic one, which the new editor can't hold as a draft. After the move it stays as it is live; change it in the new editor if you want.` });
  }
  carried.sort(byName);
  const keptIds = new Set(f.reconcile.kept.map((k) => k.id));
  const kept = docs
    .filter((d) => keptIds.has(d.id))
    .map((d) => ({ name: plainName(d) }))
    .sort(byName);
  const flagged = f.validation
    .map((v) => {
      const doc = docs.find((d) => d.id === v.id);
      const n = Math.max(v.draft.errors, v.published?.errors ?? 0);
      const messages = [...new Set([...(v.published?.messages ?? []), ...v.draft.messages])].slice(0, 2);
      return { name: plainName(doc), count: n, messages, blocksSaving: v.draft.blocksSaving > 0 };
    })
    .filter((x) => x.count > 0 || x.blocksSaving)
    .sort(byName);

  const fam = f.templates.byFamily;
  const famWords = Object.keys(fam)
    .sort()
    .map((k) => pluralize(fam[k], k === "journal" ? "journal post" : k === "campaign" ? "campaign page" : "page", k === "journal" ? "journal posts" : k === "campaign" ? "campaign pages" : "pages"));
  const templates = {
    count: f.templates.count,
    byFamily: fam,
    text: f.templates.count
      ? `${pluralize(f.templates.count, "saved template", "saved templates")} (${famWords.join(", ")}). They are not changed. After the move they stay readable on the Saved templates page of the new editor, where you can make a page from one.`
      : "None.",
  };
  const team = f.cartOffer ? cartAccessChanges() : [];

  const ready = fixes.length === 0;
  // P4-REVERSE: a move after a reversal (OQ-9 default). Only present then, so
  // a first move's report is unchanged.
  const recut = names?.restore ?? null;
  const extra = {};
  if (recut?.restored?.length) extra.editsComingBack = recut.restored.map((r) => ({ name: r.name, text: r.text }));
  if (recut?.kept?.length) extra.publishedKept = recut.kept.map((k) => ({ name: k.name, text: k.text }));
  return {
    ...extra,
    verdict: { ready, line: ready ? "Ready to move" : `Not ready: ${pluralize(fixes.length, "thing to fix", "things to fix")}`, fixes },
    shopperChanges: changes,
    shopperChangesChecked: checked,
    draftsCarried: carried,
    draftsKept: kept,
    editorFlags: flagged,
    unmatchedAddresses: unmatched,
    savedTemplates: templates,
    teamAccess: team,
    details: {
      tenant: f.tenant,
      state: f.state,
      published: f.published,
      flag: f.flag,
      stateNotes: f.stateNotes,
      live: f.live,
      refusals: f.refusals,
      mapping: f.documents,
      list: f.list,
      releaseId: mapped.releaseId,
      sourceHash: mapped.sourceHash,
      versions: [...mapped.bodies.keys()].sort(),
      refs: mapped.refs.length,
      notes: f.notes,
      leftOut: f.leftOut,
      unresolvedRedirects: f.unresolvedRedirects,
      sectionsThatWouldChange: (check?.differences ?? []).map((d) => ({ fn: d.fn, args: d.args })),
      strictValidation: f.validation,
      typesWithoutEditor: f.typesWithoutEditor,
      reconcile: f.reconcile,
      cmsTemplates: f.templates,
      codeDefaultPages: f.codeDefaultPages,
      entities: f.entities,
      dataCheck: check,
      // the routes the comparison was given (the dry run passes routesFor's)
      routesChecked: Array.isArray(routes) ? routes.map(([fn, args]) => ({ fn, args })) : null,
      estimates: f.estimates,
    },
  };
}

export const reportDigest = (report) => sha256Hex(stableStringify(report));

const bullet = (s) => `  - ${s}`;

export function renderText(report, digest) {
  const out = [];
  const v = report.verdict;
  out.push(v.line);
  v.fixes.forEach((x, i) => out.push(`  ${i + 1}. ${x.what} Where: ${x.where}`));
  out.push("");
  const section = (title, lines, none = "Nothing.") => {
    out.push(title);
    out.push(...(lines.length ? lines.map(bullet) : [`  ${none}`]));
    out.push("");
  };
  section(
    SECTION_TITLES[0],
    report.shopperChanges.map((c) => c.text),
    report.shopperChangesChecked === true ? "Nothing." : NOT_CHECKED,
  );
  section(SECTION_TITLES[1], report.draftsCarried.map((d) => d.text), "None.");
  section(SECTION_TITLES[2], report.draftsKept.map((d) => `${d.name}: the draft already in the new editor is kept as an older version.`), "None.");
  section(
    SECTION_TITLES[3],
    report.editorFlags.map((x) => `${x.name}: ${pluralize(x.count, "thing", "things")} to look at${x.messages.length ? `, such as: ${x.messages.join(" ")}` : ""}${x.blocksSaving ? " The new editor can't save this until it's fixed." : ""}`),
    "None.",
  );
  section(SECTION_TITLES[4], report.unmatchedAddresses.map((a) => a.text), "None.");
  out.push(SECTION_TITLES[5]);
  out.push(`  ${report.savedTemplates.text}`);
  out.push("");
  section(SECTION_TITLES[6], report.teamAccess.map((t) => t.text), "None.");
  // P4-REVERSE: only on a move after a reversal
  if (report.editsComingBack) section(RECUT_TITLES[0], report.editsComingBack.map((x) => x.text));
  if (report.publishedKept) section(RECUT_TITLES[1], report.publishedKept.map((x) => x.text));

  out.push(DETAILS_LINE);
  const d = report.details;
  out.push(`  store ${d.tenant}; state ${d.state}; published from ${d.published ?? "(refused)"}; flag ${d.flag ?? "none"}; live release ${d.live ? `${d.live.id} (v${d.live.v})` : "none"}`);
  out.push(`  refusals: ${d.refusals.length ? d.refusals.map((r) => r.code + (r.type ? `:${r.type}` : r.slug ? `:${r.slug}` : "")).join(", ") : "none"}`);
  out.push(`  source hash ${d.sourceHash}; release ${d.releaseId ?? "none"}; ${d.versions.length} versions; ${d.refs} reference rows`);
  out.push("  mapping:");
  for (const m of d.mapping) out.push(`    ${m.id} (${m.type}${m.slug ? ` /${m.slug}` : ""}) -> ${m.publishedVersionId ?? "not published"}${m.dirty ? ", draft differs" : ""}`);
  if (d.leftOut.length) {
    out.push("  left out of the bodies (never shown; kept in the old tables):");
    for (const l of d.leftOut) {
      const { side, what, reason, ...rest } = l;
      out.push(`    ${side} ${what} ${reason}: ${JSON.stringify(rest).slice(0, 160)}`);
    }
  }
  if (d.notes.length) out.push(`  notes: ${d.notes.map((n) => `${n.code} ${n.document}`).join("; ")}`);
  out.push(`  unresolved redirects: ${d.unresolvedRedirects.length ? d.unresolvedRedirects.map((r) => `${r.side} ${r.from_slug} -> ${r.to_slug}`).join("; ") : "none"}`);
  out.push(`  strict validation: ${d.strictValidation.length ? "" : "every document passes"}`);
  for (const s of d.strictValidation)
    out.push(`    ${s.id}: draft ${s.draft.errors} errors in ${s.draft.sections} sections [${s.draft.codes.join(", ")}]${s.published ? `; live ${s.published.errors} errors in ${s.published.sections} sections [${s.published.codes.join(", ")}]` : ""}${s.draft.blocksSaving ? `; ${s.draft.blocksSaving} would stop a draft save` : ""}`);
  out.push(`  types holding content without an editor: ${d.typesWithoutEditor.length ? d.typesWithoutEditor.map((t) => t.type).join(", ") : "none"}`);
  const rc = d.reconcile;
  out.push(
    `  reconcile: ${rc.byId.length} documents rows already there by id (${rc.kept.length} with a different draft, kept as a version); ${rc.entity.length} entity rows (${rc.entity.filter((e) => e.reused).length} phase-3 ids reused); ${rc.collisions.length} slug collisions; live rows: ${rc.liveRows.product.length} product, ${rc.liveRows.collection.length} collection`,
  );
  for (const e of rc.entity) out.push(`    ${e.type} ${e.entityId}: ${e.id}${e.reused ? ` (reused; not ${e.deterministicId})` : ""}`);
  for (const c of rc.collisions) out.push(`    slug ${c.slug}: mapped ${c.mapped.id}, held by ${c.existing.id}`);
  out.push(`  cms_templates: ${d.cmsTemplates.count} ${JSON.stringify(d.cmsTemplates.byFamily)}`);
  out.push(`  code-default pages served from code: ${d.codeDefaultPages.length ? d.codeDefaultPages.join(", ") : "none"}`);
  out.push(`  entity content: ${JSON.stringify(d.entities.holds)}; entity mapper ${d.entities.built ? "built" : "not built yet (P4-OVL07)"}`);
  const c = d.dataCheck;
  out.push(
    c?.ran
      ? `  data check: ${c.compared} getter calls compared, ${c.differences.length} differences; entity getters (resolvedProductOverride, resolvedCollectionPins, resolvedPdpPairs, per-entity resolvedSurfaceTemplateFor) wait for P4-OVL07${c.skipped ? ` (${c.skipped} such calls skipped)` : ""}`
      : `  data check: not run (${c?.reason ?? "no list"})`,
  );
  if (d.routesChecked) {
    // which routes the in-process comparison covered, by getter (P4-FIX1)
    const byFn = new Map();
    for (const r of d.routesChecked) {
      if (!byFn.has(r.fn)) byFn.set(r.fn, []);
      if (r.args.length) byFn.get(r.fn).push(r.args.map((a) => JSON.stringify(a)).join(","));
    }
    out.push(`  routes given to the data check (${d.routesChecked.length}):`);
    for (const [fn, calls] of byFn) out.push(`    ${fn}${calls.length ? `: ${calls.join("; ")}` : ""}`);
  }
  for (const x of c?.differences ?? []) out.push(`    ${x.fn}(${x.args.map((a) => JSON.stringify(a)).join(",")}): ${JSON.stringify(x.legacy).slice(0, 160)} -> ${JSON.stringify(x.candidate).slice(0, 160)}`);
  out.push(`  estimated statements: backfill ${d.estimates.backfillStatements}, flip ${d.estimates.flipStatements}`);
  out.push("");
  out.push(`Dry-run digest: ${digest}`);
  return out.join("\n");
}


// ---- P4-CUTOVER: the dry run, shared with the cutover's digest check ------------------------

// The catalog names of the products and collections the entity routes ask
// about (Shopify-owned; read only to name them in the report).
async function selectNames(sql, ids, table) {
  const out = {};
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    try {
      const r = await libsql.execute({ sql: sql.replace("(?)", `(${part.map(() => "?").join(", ")})`), args: part });
      for (const row of r.rows) out[String(row.k)] = row.title == null ? "" : String(row.title);
    } catch (e) {
      if (!notMigratedYet(e, { table })) throw e;
    }
  }
  return out;
}

export async function namesFor(mapped, routes = []) {
  const { products } = entityIdsOf(mapped);
  const handles = [...new Set(routes.filter(([fn]) => fn === "resolvedCollectionPins").map(([, a]) => String(a[0])))].sort();
  const collectionIds = [...new Set(routes.filter(([fn, a]) => fn === "resolvedSurfaceTemplateFor" && a[0] === "collection" && a[1] != null).map(([, a]) => String(a[1])))].sort();
  return {
    products: await selectNames("SELECT id AS k, title FROM products WHERE id IN (?)", products, "products"),
    collections: {
      ...(await selectNames("SELECT handle AS k, title FROM collections WHERE handle IN (?)", handles, "collections")),
      ...(await selectNames("SELECT id AS k, title FROM collections WHERE id IN (?)", collectionIds, "collections")),
    },
  };
}

// The routes the dry run compares: routesFor's plus the entity routes
// dataCheck always adds (P4-OVL07), once each.
export async function dryRunRoutes(mapped) {
  const seen = new Set();
  return [...routesFor(mapped.source), ...(await entityRoutesFor(mapped))].filter((r) => {
    const k = JSON.stringify(r);
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

/**
 * The whole dry run, in the tenant's context. Read-only. The cutover's
 * "matching dry-run digest" precondition calls exactly this.
 */
export async function dryRun({ storeOpen, platform = null } = {}) {
  // P4-REVERSE: after a reversal, the overlay edits that come back (the
  // cutover's mapForRun applies the very same step)
  const mapped = await restoreForRun(await mapTenant({ storeOpen, platform }));
  const routes = await dryRunRoutes(mapped);
  const check = await dataCheck(mapped, { routes });
  const names = await namesFor(mapped, routes);
  if (mapped.restored?.length || mapped.keptPublished?.length) names.restore = { restored: await restoredNames(mapped.restored), kept: await keptNames(mapped.keptPublished) };
  const report = buildReport(mapped, check, { routes, names });
  return { mapped, check, routes, names, report, digest: await reportDigest(report) };
}


// ---- P4-CUTOVER: the move's own words --------------------------------------------------------

const when = (iso) => {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "an unknown time";
  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

export function howLong(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "less than a minute";
  if (m < 60) return pluralize(m, "minute", "minutes");
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${pluralize(h, "hour", "hours")}${rest ? ` and ${pluralize(rest, "minute", "minutes")}` : ""}`;
}

// What each step means to the owner (no table names).
export const STEP_WORDS = Object.freeze({
  locked: "the store was paused for the update (old editors don't save, the catalog copy waits)",
  rechecked: "the store was checked again after the pause",
  backfilled: "your content was copied into the new editor",
  checked: "the copy was compared with your live store and matched",
  flipped: "the store was switched to the new editor",
  pinned: "the store's look was recorded",
  searched: "search was asked to update",
});
export const stepWords = (step) => {
  if (typeof step === "string" && step.startsWith("backfill:")) return `your content is being copied into the new editor (part ${Number(step.slice(9)) + 1} copied)`;
  return STEP_WORDS[step] || "the update started";
};

// How to run the command again with a flag. The command passes its own
// invocation (scripts/migrate-documents.js); without one, plain words.
const sameCommand = (flag) => `the same command with ${flag}`;

/**
 * --status, in plain words. status = runs.js storeStatus(); now = ms.
 */
export function renderStatusText(status, { tenant, now = Date.now(), command = sameCommand } = {}) {
  const out = [];
  const cmd = (_t, flag) => command(flag);
  const run = status?.run;
  const mode = status?.mode;
  if (run && run.kind === "cutover") {
    const started = Date.parse(run.started_at);
    const after = !["locked", "rechecked", "backfilled", "checked"].includes(run.step) && !String(run.step).startsWith("backfill:");
    if (after) {
      out.push("Your store has moved to the new editor, but the last steps of the move didn't finish.");
      out.push(`  Started: ${when(run.started_at)}, ${howLong(now - started)} ago.`);
      out.push(`  Done so far: ${stepWords(run.step)}.`);
      out.push("  Shoppers see your store as usual, and the new editor works.");
      out.push("");
      out.push("What to do next");
      out.push(`  - Run: ${cmd(tenant, "--resume")}`);
      out.push("    It finishes the last steps (recording the store's look, updating search).");
      out.push("  - The move can't be stopped any more. To go back to the old editor, use the reversal tool (the reverse:documents command).");
    } else {
      out.push("Your store is being updated (moving to the new editor).");
      out.push(`  Started: ${when(run.started_at)}, ${howLong(now - started)} ago.`);
      out.push(`  Done so far: ${stepWords(run.step)}.`);
      out.push("  While this lasts, the old editors don't save and the catalog copy from Shopify waits. Shoppers still see your store as before.");
      const stopped = status.report?.stopped;
      if (stopped?.words) out.push(`  It stopped because: ${stopped.words}`);
      out.push("");
      out.push("What to do next");
      out.push(`  - To carry on from here: ${cmd(tenant, "--resume")} (with the same proofs you gave the first time)`);
      out.push(`  - To stop and go back to the old editor: ${cmd(tenant, "--abort")}`);
      out.push("    Nothing shoppers see changes either way until the move finishes.");
    }
    return out.join("\n");
  }
  if (run) {
    out.push("Your store is being moved back to the old editor (a reversal is under way).");
    out.push(`  Started: ${when(run.started_at)}, ${howLong(now - Date.parse(run.started_at))} ago.`);
    out.push("");
    out.push("What to do next");
    out.push(`  - Use the reversal tool's own status: reverse:documents --tenant ${tenant} --status`);
    return out.join("\n");
  }
  if (mode === "documents") out.push("Your store uses the new editor. No update is under way.");
  else if (mode === "migrating") out.push("Your store is marked as being updated, but no update is recorded. Ask Storeasy support to look at it before anything else.");
  else out.push("Your store uses the old editor. No update is under way.");
  const last = status?.last;
  if (last) {
    const o = last.outcome === "done" ? "finished" : last.outcome === "aborted" ? "was stopped and the store went back to the old editor" : last.outcome === "stopped" ? "stopped before anything changed for shoppers" : "ended";
    out.push(`  The last move ${o} at ${when(last.finished_at || last.started_at)}.`);
    const why = parseLastWords(status.lastReport);
    if (why) out.push(`  Why: ${why}`);
  }
  return out.join("\n");
}

const parseLastWords = (r) => (r && typeof r === "object" && r.stopped?.words ? r.stopped.words : null);

export function renderRefusal(r) {
  const lines = [`Not moved: ${r.message}`];
  for (const f of r.fixes || []) lines.push(`  - ${f.what} Where: ${f.where}`);
  lines.push("Nothing was changed.");
  if (r.after) lines.push(r.after);
  return lines.join("\n");
}

const listOrNone = (lines) => (lines.length ? lines.map((l) => `  - ${l}`) : ["  None."]);

/**
 * The move's report, in plain words, then Details. `r` is the run's report
 * (cutover.js).
 */
export function renderCutoverText(r) {
  const out = [];
  if (r.rehearsal) {
    out.push(r.passed ? "Rehearsal passed: the copy moved to the new editor and looks the same to shoppers." : "Rehearsal did NOT pass: see below.");
    out.push("  This ran on a copy of your store on this machine. Nothing on your real store changed.");
  } else if (r.outcome === "done") out.push("Your store now uses the new editor.");
  else if (r.flippedAt) out.push("Your store now uses the new editor, but the last steps didn't finish (see below).");
  else out.push("Your store was not moved.");
  if (r.flippedAt) out.push(`  Switched at ${when(r.flippedAt)}. Shoppers saw no change.`);
  if (r.stopped?.words) out.push(`  ${r.stopped.words}`);
  out.push("");
  const c = r.counts || {};
  out.push("What was moved");
  out.push(
    ...listOrNone(
      [
        c.documents ? `${pluralize(c.documents, "page or part of your store", "pages and parts of your store")} now open in the new editor` : null,
        c.liveRows?.product ? `the extras of ${pluralize(c.liveRows.product, "product", "products")} (sections, badges, products shown together, layouts)` : null,
        c.liveRows?.collection ? `the pinned products or layouts of ${pluralize(c.liveRows.collection, "collection", "collections")}` : null,
        c.dirty ? `${pluralize(c.dirty, "unpublished change carries", "unpublished changes carry")} over as drafts` : null,
      ].filter(Boolean),
    ),
  );
  // P4-REVERSE: a move after a reversal
  if (r.restored?.length) {
    out.push("");
    out.push("Edits that came back");
    out.push(...listOrNone(r.restored.map((x) => x.text)));
    if (r.restoreSkipped) out.push("  (Left out of this rehearsal, so the page comparison stays exact; the real move brings them back.)");
  }
  if (r.keptPublished?.length) {
    out.push("");
    out.push(RECUT_TITLES[1]);
    out.push(...listOrNone(r.keptPublished.map((x) => x.text)));
  }
  out.push("");
  out.push("Drafts kept as older versions");
  out.push(...listOrNone((r.kept || []).map((k) => `${k.name}: the draft that was already in the new editor is kept as an older version.`)));
  out.push("");
  out.push("Old addresses that couldn't be matched");
  out.push(...listOrNone((r.unresolvedRedirects || []).map((x) => `/${x.from_slug} sent shoppers to /${x.to_slug}, which isn't a page stored in your store.`)));
  out.push("");
  out.push("Saved templates");
  out.push(r.cmsTemplates ? `  ${pluralize(r.cmsTemplates, "saved template stays", "saved templates stay")} readable on the Saved templates page of the new editor.` : "  None.");
  out.push("");
  out.push("The store's look (for Storeasy's own screens)");
  const p = r.themePin || {};
  out.push(
    `  ${
      p.status === "written"
        ? "Recorded."
        : p.status === "nothing"
          ? "Nothing to record (your store uses the standard look)."
          : p.status === "env"
            ? "Not needed for this store."
            : p.status === "skipped"
              ? "Not recorded: this was a rehearsal on a copy."
              : p.status === "failed"
                ? `Couldn't be recorded. Shoppers aren't affected. Run the same command with --resume to try again.`
                : "Not done yet."
    }`,
  );
  out.push("");
  out.push("Search");
  const s = r.search || {};
  out.push(
    `  ${
      s.status === "drained" || s.status === "queued"
        ? "Search is being updated."
        : s.status === "nothing"
          ? "Nothing to update."
          : s.status === "skipped"
            ? "Not updated: this was a rehearsal on a copy."
            : s.status === "failed"
              ? "Search couldn't be updated just now. It catches up at the next catalog copy from Shopify; nothing else is affected."
              : "Not done yet."
    }`,
  );
  if (r.rehearsal) {
    out.push("");
    out.push("The comparison with your live store");
    out.push(`  As data: ${r.dataCheck?.ran ? (r.dataCheck.differences ? `${pluralize(r.dataCheck.differences, "difference", "differences")} found.` : "the same.") : "not run."}`);
    out.push(`  As pages: ${r.render ? (r.render.same ? `the same (${pluralize(r.render.compared, "page", "pages")} compared).` : `NOT the same. ${r.render.words || ""}`.trim()) : "not run."}`);
  }
  out.push("");
  out.push(DETAILS_LINE);
  out.push(`  store ${r.tenant}; run ${r.runId}; state ${r.state}; live release at the pause ${r.liveAtLock ?? "none"}; new release ${r.releaseId ?? "none"}`);
  out.push(`  source hash ${r.sourceHash}; started ${r.startedAt}; switched ${r.flippedAt ?? "-"}; finished ${r.finishedAt ?? "-"}; outcome ${r.outcome ?? "open"}`);
  out.push(
    `  documents ${c.documents ?? 0} (new ${c.documentsNew ?? 0}, changed ${c.documentsChanged ?? 0}, same ${c.documentsSame ?? 0}); versions ${c.versions ?? 0}; kept ${c.kept ?? 0}; refs ${c.refs ?? 0}; release refs ${c.releaseRefs ?? 0}; live rows ${c.liveRows?.product ?? 0} product, ${c.liveRows?.collection ?? 0} collection, ${c.liveRowsCleared ?? 0} cleared; log rows ${c.log ?? 0}; outbox rows ${c.outbox ?? 0}; publish jobs cancelled ${c.jobsCancelled ?? 0}`,
  );
  if (r.dataCheck) out.push(`  data check: ${r.dataCheck.ran ? `${r.dataCheck.compared} getter calls, ${r.dataCheck.differences} differences` : "not run"}`);
  for (const d of r.dataCheck?.list || []) out.push(`    ${d.fn}(${(d.args || []).map((a) => JSON.stringify(a)).join(",")})`);
  out.push(`  theme_pin: ${JSON.stringify(r.themePin ?? null)}`);
  out.push(`  search: ${JSON.stringify(r.search ?? null)}`);
  if (r.dropped?.length) out.push(`  left out of product extras: ${JSON.stringify(r.dropped).slice(0, 400)}`);
  if (r.stopped) out.push(`  stopped: ${r.stopped.code}${r.stopped.detail ? ` ${JSON.stringify(r.stopped.detail).slice(0, 400)}` : ""}`);
  return out.join("\n");
}


// ---- P4-REVERSE (MIG-04): moving back to the old editor, and moving again ------------------
//
//   EDIT_WORDS                  an overlay field (or live column) in founder words
//   editWords(fields, values)   "new name (“Protein Bar Max”), description"
//   restoredNames(restored)     the move-after-a-reversal's restored products,
//                               by name: [{ productId, name, fields, text }]
//   keptNames(kept)             documents published in the new editor whose
//                               content stays as older versions: [{ id, name, text }]
//   renderReversePlanText(plan, digest)   the reversal's dry run
//   renderReverseText(report)             what the reversal did
//   founderMessage(report)                a message the owner can pass on
//   renderReverseStatusText(status, { tenant, now, command })
//   renderReverseRefusal(refusal)

export const RECUT_TITLES = Object.freeze(["Edits that come back at the move", "Published in the new editor before, kept as older versions"]);
export const REVERSE_TITLES = Object.freeze([
  "What shoppers will see change",
  "Edits from the new editor that won't show any more",
  "Unpublished drafts in the new editor",
  "After going back",
]);

export const EDIT_WORDS = Object.freeze({
  title: "new name",
  description_html: "description",
  description: "description",
  gallery: "photos",
  featured_image: "photos",
  featured_image_alt: "photos",
  display_vendor: "brand shown",
  display_type: "product type shown",
  keep_variant_images: "photos for each option",
  seo_title: "search engine text",
  seo_description: "search engine text",
  og_image: "sharing image",
  extras: "extra sections, badge, products shown together or layout",
  pinned: "pinned products or layout",
});

const EDIT_ORDER = ["title", "description_html", "description", "gallery", "featured_image", "featured_image_alt", "display_type", "display_vendor", "keep_variant_images", "seo_title", "seo_description", "og_image", "extras", "pinned"];

const overlayText = (v) => (v != null && typeof v === "object" && !Array.isArray(v) && "value" in v ? v.value : v);

// "new name (“Protein Bar Max”), description, photos": each kind of edit once,
// the new name quoted when it is known.
export function editWords(fields, values = {}) {
  const seen = new Set();
  const out = [];
  for (const f of [...fields].sort((a, b) => EDIT_ORDER.indexOf(a) - EDIT_ORDER.indexOf(b))) {
    const w = EDIT_WORDS[f];
    if (!w || seen.has(w)) continue;
    seen.add(w);
    const name = f === "title" ? overlayText(values.title) : null;
    out.push(typeof name === "string" && name ? `${w} (“${name}”)` : w);
  }
  return out.join(", ");
}

async function titlesOf(table, ids) {
  return selectNames(`SELECT id AS k, title FROM ${table} WHERE id IN (?)`, [...new Set(ids.filter(Boolean))].sort(), table);
}
const namedProduct = (names, id) => (names[id] ? `“${names[id]}”` : "A product that is no longer in your catalog");

export async function restoredNames(restored = []) {
  const names = await titlesOf("products", restored.map((r) => r.productId));
  return restored
    .map((r) => {
      const name = namedProduct(names, r.productId);
      return { productId: r.productId, name, fields: r.fields, text: `${name}: ${editWords(r.fields, r.columns || {})}.` };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function keptNames(kept = []) {
  const products = await titlesOf("products", kept.filter((k) => k.type === "product_content").map((k) => k.entityId));
  const collections = await titlesOf("collections", kept.filter((k) => k.type === "collection_content").map((k) => k.entityId));
  return kept
    .map((k) => {
      let name;
      let text;
      if (k.type === "product_content") {
        name = namedProduct(products, k.entityId);
        text = k.restored ? `${name}: the rest of what was published for it in the new editor (its name, description and photos come back).` : `${name}: what was published for it in the new editor.`;
      } else if (k.type === "collection_content") {
        name = collections[k.entityId] ? `The collection “${collections[k.entityId]}”` : "A collection";
        text = `${name}: its pinned products or layout published in the new editor.`;
      } else {
        name = plainName(k);
        text = `${name}: what was published in the new editor.`;
      }
      return { id: k.id, name, text };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// The products and parts of the store whose new-editor edits stop showing.
function lostLines(plan) {
  const lines = [];
  for (const p of plan.products || []) lines.push(`${p.name}: ${editWords(p.fields, p.values || {})}.`);
  for (const c of plan.collections || []) lines.push(`${c.name}: ${editWords(c.fields)}.`);
  for (const d of plan.pages || []) lines.push(`${d.name}: what was published in the new editor.`);
  return lines;
}

function reverseCounts(plan) {
  const c = plan.counts || {};
  return [
    `${pluralize(c.publishedDocuments || 0, "part of your store was", "parts of your store were")} published in the new editor since the move (${pluralize(c.publishes || 0, "publish", "publishes")}).`,
    `${pluralize(c.overlayFields || 0, "product edit", "product edits")} (names, descriptions, photos, brand or type shown) on ${pluralize(c.overlayProducts || 0, "product", "products")} follow Shopify again.`,
    `${pluralize(c.drafts || 0, "unpublished draft stays", "unpublished drafts stay")} in the new editor.`,
  ];
}

const AFTER_LINES = [
  "The old editors work again at once; edits made there show as before.",
  "Moving to the new editor again later brings the product edits listed above back (names, descriptions, photos, brand and type shown). Other things published in the new editor stay saved as older versions there.",
];

export function renderReversePlanText(plan, digest) {
  const out = [];
  if (plan.refused) {
    out.push(`Not ready: ${plan.refused.message}`);
    out.push("");
  } else out.push("Ready to move back to the old editor");
  out.push("");
  const section = (title, lines, none = "Nothing.") => {
    out.push(title);
    out.push(...(lines.length ? lines.map(bullet) : [`  ${none}`]));
    out.push("");
  };
  const lost = lostLines(plan);
  section(REVERSE_TITLES[0], lost.length ? [...lost.map((l) => `${l} Shoppers see what the old editor had again.`)] : [], "Nothing: shoppers see the store as it was before the move.");
  section(REVERSE_TITLES[1], reverseCounts(plan));
  section(REVERSE_TITLES[2], (plan.drafts || []).map((d) => d.name), "None.");
  section(REVERSE_TITLES[3], AFTER_LINES);
  out.push(DETAILS_LINE);
  out.push(`  store ${plan.tenant}; mode ${plan.mode}; live release after going back ${plan.target ?? "none (the drafts)"}; moved at ${plan.since ?? "-"}`);
  out.push(`  live rows: ${plan.counts?.liveProducts ?? 0} product, ${plan.counts?.liveCollections ?? 0} collection`);
  for (const p of plan.products || []) out.push(`    ${p.id}: ${p.fields.join(", ")}`);
  out.push("");
  if (digest) out.push(`Reversal dry-run digest: ${digest}`);
  return out.join("\n");
}

export function founderMessage(r) {
  const plan = r.plan || r;
  const lines = [];
  lines.push("Your store is back on the old editor. Shoppers see it as it was before the move to the new editor.");
  const lost = lostLines(plan);
  if (lost.length) {
    lines.push("These edits from the new editor don't show any more:");
    for (const l of lost) lines.push(`  - ${l}`);
  } else lines.push("No edit from the new editor was live, so nothing you published there is lost from view.");
  if ((plan.drafts || []).length) lines.push(`Your ${pluralize(plan.drafts.length, "unpublished draft", "unpublished drafts")} in the new editor ${plan.drafts.length === 1 ? "is" : "are"} kept there.`);
  lines.push("The old editors work again right away.");
  lines.push("When your store moves to the new editor again, the product edits above (names, descriptions, photos, brand and type shown) come back. Other things you published in the new editor stay saved there as older versions.");
  return lines.join("\n");
}

export function renderReverseText(r) {
  const out = [];
  if (r.outcome === "done") out.push("Your store is back on the old editor.");
  else if (r.outcome === "aborted") out.push("The reversal was stopped: your store stays on the new editor.");
  else out.push("Your store was not moved back.");
  if (r.reversedAt) out.push(`  Moved back at ${when(r.reversedAt)}.`);
  if (r.stopped?.words) out.push(`  ${r.stopped.words}`);
  out.push("");
  const plan = r.plan || {};
  const section = (title, lines, none = "Nothing.") => {
    out.push(title);
    out.push(...(lines.length ? lines.map(bullet) : [`  ${none}`]));
    out.push("");
  };
  section(REVERSE_TITLES[1], [...lostLines(plan), ...reverseCounts(plan)]);
  section(REVERSE_TITLES[2], (plan.drafts || []).map((d) => d.name), "None.");
  out.push("Search");
  const s = r.search || {};
  out.push(
    `  ${
      s.status === "drained" || s.status === "queued"
        ? "Search is being updated to Shopify's names."
        : s.status === "nothing"
          ? "Nothing to update."
          : s.status === "failed"
            ? "Search couldn't be updated just now. It catches up at the next catalog copy from Shopify; nothing else is affected."
            : "Not done yet."
    }`,
  );
  out.push("");
  out.push("The store's look (for Storeasy's own screens)");
  const p = r.themePin || {};
  out.push(
    `  ${
      p.status === "reset"
        ? "Set back to the old editor's look."
        : p.status === "env"
          ? "Not needed for this store."
          : p.status === "failed"
            ? "Couldn't be set back. Shoppers aren't affected. Run the same command with --resume to try again."
            : "Not done yet."
    }`,
  );
  out.push("");
  if (r.outcome === "done") {
    out.push("A message you can pass on");
    for (const l of founderMessage(r).split("\n")) out.push(`  ${l}`);
    out.push("");
  }
  out.push(DETAILS_LINE);
  out.push(`  store ${r.tenant}; run ${r.runId}; live release after going back ${r.target ?? "none (the drafts)"}; started ${r.startedAt}; moved back ${r.reversedAt ?? "-"}; outcome ${r.outcome ?? "open"}`);
  const c = r.counts || {};
  out.push(`  copied aside: ${c.productRows ?? 0} product rows, ${c.collectionRows ?? 0} collection rows; search outbox rows ${c.outbox ?? 0}`);
  out.push(`  theme_pin: ${JSON.stringify(r.themePin ?? null)}`);
  out.push(`  search: ${JSON.stringify(r.search ?? null)}`);
  if (r.stopped) out.push(`  stopped: ${r.stopped.code}${r.stopped.detail ? ` ${JSON.stringify(r.stopped.detail).slice(0, 300)}` : ""}`);
  return out.join("\n");
}

export const REVERSE_STEP_WORDS = Object.freeze({
  locked: "the store was paused for going back (the new editor doesn't publish and the old editors don't save yet)",
  reversed: "the store went back to the old editor",
  searched: "search was asked to update",
  pinned: "the store's look was set back",
});

export function renderReverseStatusText(status, { tenant, now = Date.now(), command = sameCommand } = {}) {
  const out = [];
  const run = status?.run;
  if (run && run.kind === "reverse") {
    out.push("Your store is being moved back to the old editor.");
    out.push(`  Started: ${when(run.started_at)}, ${howLong(now - Date.parse(run.started_at))} ago.`);
    out.push(`  Done so far: ${REVERSE_STEP_WORDS[run.step] || "the update started"}.`);
    out.push("  While this lasts, nothing can be published or saved in either editor. Shoppers still see the store as it was in the new editor.");
    const stopped = status.report?.stopped;
    if (stopped?.words) out.push(`  It stopped because: ${stopped.words}`);
    out.push("");
    out.push("What to do next");
    out.push(`  - To finish going back to the old editor: ${command("--resume")}`);
    out.push(`  - To stop and stay on the new editor: ${command("--abort")}`);
    return out.join("\n");
  }
  if (run) {
    out.push("Your store is being moved to the new editor (a move is under way), not back.");
    out.push("");
    out.push("What to do next");
    out.push(`  - Use the move tool's own status: migrate:documents --tenant ${tenant} --status`);
    return out.join("\n");
  }
  const mode = status?.mode;
  if (mode === "documents") out.push("Your store uses the new editor. No reversal is under way.");
  else if (mode === "migrating") out.push("Your store is marked as being updated, but no update is recorded. Ask Storeasy support to look at it before anything else.");
  else out.push("Your store uses the old editor. No reversal is under way.");
  const last = status?.last;
  if (last) {
    const o = last.outcome === "done" ? "moved the store back to the old editor" : last.outcome === "aborted" ? "was stopped, and the store stayed on the new editor" : last.outcome === "stopped" ? "stopped before anything changed for shoppers" : "ended";
    out.push(`  The last reversal ${o} at ${when(last.finished_at || last.started_at)}.`);
    const lr = status.lastReport || {};
    if (last.outcome === "done" && (lr.themePin?.status === "failed" || lr.search?.status === "failed" || !lr.themePin)) {
      out.push(`  Its last steps (setting the store's look back, updating search) didn't all finish. Run: ${command("--resume")}`);
    }
    if (lr.stopped?.words) out.push(`  Why: ${lr.stopped.words}`);
  }
  return out.join("\n");
}

export function renderReverseRefusal(r) {
  const lines = [`Not moved back: ${r.message}`];
  lines.push("Nothing was changed.");
  return lines.join("\n");
}
