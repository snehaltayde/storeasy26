// P4-MAPPER (MIG-01, MIG-02): the dry-run report, in plain words a founder
// can act on, with the developer detail below a "Details" line. P4-CUTOVER and
// P4-REVERSE add to this file later.
//
//   buildReport(mapped, dataCheck)   the full report, as plain JSON (what
//                                    --json prints, and what the digest hashes)
//   renderText(report, digest)       the default output: the verdict line and
//                                    the plain sections, in this order, then
//                                    "Details", then the digest
//   reportDigest(report)             sha256 of the report's canonical JSON:
//                                    the same whatever the output format
//
// Plain sections (above "Details"): no table names, no error codes, no ids,
// no statement counts. scripts/test-migrate-map.js checks that.
import { stableStringify, documentType } from "../registry/index.js";
import { livePath } from "../documents/paths.js";
import { ROLES, roleAllows } from "../platform/authz.js";
import { sha256Hex } from "./ids.js";

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
function routeName(fn, args, docs) {
  const bySlug = (slug) => docs.find((d) => d.slug === slug);
  switch (fn) {
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
    case "resolvedSurfaceTemplateFor":
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

export function buildReport(mapped, check = null, { routes = null } = {}) {
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
  for (const d of check?.differences ?? []) {
    const name = routeName(d.fn, d.args, docs);
    if (d.fn === "resolvedSlugRedirect" && typeof d.legacy?.ok === "string") addChange(name, `${capital(name)} would stop sending shoppers to /${d.legacy.ok}.`);
    else addChange(name, `${capital(name)} would look different after the move.`);
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
  return {
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

