// Onboarding checklist (S41 / MC02). Node-only, runs in TENANT context.
//
// Resumable by construction: most steps are DERIVED from real state (a
// re-opened checklist can never drift from reality), and only the three
// human-judgement steps (preview, test order, launch) are stored check-offs
// (config.onboarding.manual). Launch is gated on everything before it.
import { db, libsql } from "../db.js";
import { currentTenant } from "../tenant-context.js";
import { listContentPages } from "../cms/store.js";
import { storeDesign } from "./brand-readability.js";
import { editorHref, PAGES_LIST_HREF, EDITOR_PATH, EDITOR_PUBLISH_HREF } from "./editor-entry.js";
import { getCmsMode } from "../cms-mode.js";
import { POLICY_KINDS, policyStatus, policyCounts, readPolicyRows } from "../documents/policy-pages.js";

// P6-ONBOARD (GEN-04, PUB-12, US-01, US-41): documents stores only. Legacy
// output is byte-identical (labels, hints, hrefs, done rules, no new keys).
//   - a first step, "Start your store" (/admin/start), done once doc_home
//     exists, or on an empty catalog once the brand step is recorded;
//   - the design step is also done once the brand step is recorded (saved or
//     skipped), and links /admin/start whether the store is open or closed
//     (the logo is changed there; the editor has no logo control);
//   - the policies step reads policyStatus (lib/documents/policy-pages.js),
//     the same rule and review rule as "Before you open your store" (PUB-12)
//     on a closed store, and carries `actions`: "Start a ... page" for each
//     missing kind, and "Read your ... page" plus "I've read it" for each
//     starter draft. An open store keeps the published rule and its label.
export const START_HREF = "/admin/start";
const POLICY_NOUN = Object.freeze({ privacy: "privacy page", returns: "returns page" });
export const POLICY_HINTS = Object.freeze({
  missing: "Your store can't open without a privacy page and a returns page. Start each from a template, then read it and save it.",
  openMissing: "Shoppers need a privacy page and a returns page, and checkout links them. Start each from a template, read it, then publish it.",
  ready: "Your privacy and returns pages are ready.",
  openPublish: "Publish your privacy page and your returns page so shoppers can read them. Checkout links them.",
  // P6-FIX3: the pages could not be read (readPolicyRows threw), so the step
  // can't say which are missing and offers no buttons
  unreadable: "We couldn't check your privacy and returns pages just now. Reload this page to try again.",
});
export const policyStarterHint = (kinds) => {
  const names = kinds.map((k) => `your ${POLICY_NOUN[k]}`).join(" and ");
  const it = kinds.length > 1 ? "each" : "it";
  return `We started ${names} from a template. It's a starting point, not legal advice: read ${it}, change what you need and save it, or press I've read it if it is right as it is.`;
};
export const BRAND_HINTS = Object.freeze({
  closed: "Pick your colours and logo. They go live when you open your store.",
  open: "Pick your colours and logo. They go live when you publish your design.",
});
export const START_HINTS = Object.freeze({
  todo: "See the first version of your store, made from your products, then pick your colours and logo.",
  emptyCatalog: "Pick your colours and logo. Your home page fills in once your products come in.",
  done: "Your first home page is ready. Change anything from the editor.",
});

// The brand step of /admin/start is recorded (saved or skipped).
const brandStepRecorded = (onboarding) => {
  const s = onboarding && typeof onboarding === "object" ? onboarding.brand_step : null;
  return Boolean(s && typeof s === "object" && !Array.isArray(s) && s.at);
};

// doc_home exists (any state). A read that fails reads as absent: the step
// stays open, never done on a guess.
async function homeExists() {
  try {
    const r = await libsql.execute("SELECT 1 AS x FROM documents WHERE id = 'doc_home'");
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

// The policies step's state on a documents store, from policyStatus. null
// when the rows can't be read (the step stays open, no actions).
async function documentsPolicies() {
  try {
    return policyStatus(await readPolicyRows());
  } catch {
    return null;
  }
}

// The checklist's buttons for the policies step (documents stores only).
// On an open store only the start actions (it keeps the published rule).
function policyActions(status, { starters = true } = {}) {
  if (!status) return [];
  const out = [];
  for (const kind of POLICY_KINDS) {
    const s = status[kind];
    if (s.state === "missing") out.push({ type: "startPolicy", kind, label: kind === "returns" ? "Start a returns page" : "Start a privacy page" });
    else if (starters && s.state === "starter") {
      out.push({ type: "link", href: editorHref(s.doc.id), label: kind === "returns" ? "Read your returns page" : "Read your privacy page" });
      out.push({ type: "markPolicyRead", id: s.doc.id, revision: s.doc.revision, label: "I've read it" });
    }
  }
  return out;
}

// P3-DESIGN (TOK-03): "Pick a theme & brand" is done when the store has a
// brand or a look of its own: on a documents store, in its LIVE design
// document (doc_design), and the step links to the editor at that document
// (the old Theme and Brand screens redirect there, and the documents-mode
// sidebar has no Theme or Brand link). On legacy, the control-plane drafts
// and /admin/theme, as before. A design that can't be read leaves the step
// open, never done on a guess.
// P4-PROVISION: when the design can't be read on a documents store the step
// still links to the editor (the old Theme screen is never offered there).
async function designStep(documents = false) {
  try {
    const d = await storeDesign();
    return { done: Boolean(d.brand || d.theme), href: d.mode === "documents" ? editorHref("doc_design") : "/admin/theme" };
  } catch {
    return { done: false, href: documents ? editorHref("doc_design") : "/admin/theme" };
  }
}

// P4-PROVISION (MIG-03, PUB-06): a documents store is open once it has a live
// release (its first publish), and closed ("Opening soon") before. The Launch
// step reads that live state, so an open store is never "not launched" and a
// closed one never "launched". { open, since }: since is the first release's
// time. A read that fails reads as closed (the step stays open, never done on
// a guess).
async function documentsLaunch() {
  try {
    const live = await db.selectFrom("release_state").select("live_release_id").where("id", "=", 1).executeTakeFirst();
    if (!live?.live_release_id) return { open: false, since: null };
    const first = await db.selectFrom("releases").select(({ fn }) => fn.min("created_at").as("at")).executeTakeFirst();
    return { open: true, since: first?.at || null };
  } catch {
    return { open: false, since: null };
  }
}

export const LAUNCH_HINTS = Object.freeze({
  closed: "Your store is private until your first publish: shoppers see \"Opening soon\". Publishing from the editor opens it.",
  // P6-ONBOARD (PUB-12): publishing first shows "Before you open your store"
  closedOpenSteps:
    "Your store is private until your first publish: shoppers see \"Opening soon\". Publishing from the editor opens it, and first shows what is still missing under \"Before you open your store\". It can't open without a way to pay, a privacy page and a returns page.",
  open: "Your store is open to shoppers. Publish from the editor whenever you change something.",
});
export const TEST_ORDER_CLOSED_HINT = "Your store is private, so place it from the editor's preview: add a product to the cart and pay cash on delivery. Cancel it after.";

// P4-ED05 (ED-05, spec 8.13): on a documents store the old pages table is
// frozen, so the legal-pages step reads the PUBLISHED page documents (the
// storefront's own page list over the live release, lib/cms/view.js), and
// the steps that pointed at the old screens open the editor: the pages list,
// the editor (its preview) and, for Launch, the editor's Publish. A mode that
// can't be read keeps today's links and reads (the step stays honest: its
// own reads decide done).
async function documentsPages() {
  const { publishedGetters } = await import("../cms/view.js");
  const g = await publishedGetters();
  if (g.closed) return [];
  return (await g.resolvedContentPageList()).filter((p) => (p.family || "page") === "page");
}

const isRealDomain = (d) => d && !/localhost|127\.0\.0\.1|\.vercel\.app$/.test(d);

export async function buildChecklist() {
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default") {
    return { supported: false, reason: "Onboarding tracks control-plane tenants — this store runs on environment config." };
  }
  const manual = tenant.config?.onboarding?.manual || {};
  const documents = (await getCmsMode().catch(() => null)) === "documents";

  const [productCount, pages, sync, design] = await Promise.all([
    db
      .selectFrom("products")
      .select(({ fn }) => fn.countAll().as("n"))
      .executeTakeFirst()
      .then((r) => Number(r?.n ?? 0))
      .catch(() => 0),
    (documents ? documentsPages() : listContentPages()).catch(() => []),
    // GEN-02: the step reads the sync's own record, so it can say "on its way"
    import("../sync.js").then((S) => S.catalogSyncStatus()).catch(() => null),
    designStep(documents),
  ]);
  const launch = documents ? await documentsLaunch() : null;
  const [policy, hasHome] = documents ? await Promise.all([documentsPolicies(), homeExists()]) : [null, false];
  const stepRecorded = brandStepRecorded(tenant.config?.onboarding);
  const syncView = sync?.view;
  const catalogDone = productCount > 0 || syncView?.state === "complete";
  const catalogHint = catalogDone
    ? productCount > 0
      ? `${productCount} products in`
      : "Your Shopify store has no products yet. Add some there and they'll come in."
    : syncView && ["running", "retrying"].includes(syncView.state)
      ? `${syncView.headline}: ${syncView.products.done} products so far`
      : syncView && ["failed", "stalled"].includes(syncView.state)
        ? "It didn't finish. Open Settings to try again."
        : "Starts when your Shopify store is linked. You can also start it from Settings.";
  const enabledPages = pages.filter((p) => p.enabled);
  const hasPolicy = (re) => enabledPages.some((p) => re.test(p.slug));

  // the policies step on a documents store (see the head of this file)
  const kindState = (k) => policy?.[k]?.state ?? "missing";
  const closedPoliciesDone = Boolean(policy) && POLICY_KINDS.every((k) => policyCounts(kindState(k))); // live or saved: no publish set here
  const anyMissing = POLICY_KINDS.some((k) => kindState(k) === "missing");
  const starters = POLICY_KINDS.filter((k) => kindState(k) === "starter");
  const publishedPoliciesDone = hasPolicy(/privacy/) && hasPolicy(/terms|refund|return/);
  // P6-FIX3: when the pages can't be read (policy is null) the step says so,
  // never "Start each from a template" with no buttons under it
  const policiesHint = !documents
    ? null
    : launch.open
      ? publishedPoliciesDone
        ? POLICY_HINTS.ready
        : !policy
          ? POLICY_HINTS.unreadable
          : anyMissing
            ? POLICY_HINTS.openMissing
            : POLICY_HINTS.openPublish
      : closedPoliciesDone
        ? POLICY_HINTS.ready
        : !policy
          ? POLICY_HINTS.unreadable
          : anyMissing
            ? POLICY_HINTS.missing
            : policyStarterHint(starters);

  const items = [
    ...(documents
      ? [
          {
            id: "start",
            label: "Start your store",
            kind: "auto",
            done: hasHome || (productCount === 0 && stepRecorded),
            href: START_HREF,
            hint: hasHome ? START_HINTS.done : productCount === 0 ? START_HINTS.emptyCatalog : START_HINTS.todo,
          },
        ]
      : []),
    {
      id: "connect",
      label: "Connect Shopify",
      kind: "auto",
      done: Boolean(tenant.secrets?.shopify_admin_token),
      href: "/admin/integrations",
      hint: "OAuth connect — the catalog syncs from your store.",
    },
    {
      id: "catalog",
      label: "Bring in your products",
      kind: "auto",
      done: catalogDone,
      href: "/admin/settings#catalog-sync",
      hint: catalogHint,
    },
    {
      id: "brand",
      label: "Pick a theme & brand",
      kind: "auto",
      done: documents ? design.done || stepRecorded : design.done,
      href: documents ? START_HREF : design.href,
      hint: documents ? (launch.open ? BRAND_HINTS.open : BRAND_HINTS.closed) : "Apply a kit, set your accent color.",
    },
    {
      id: "policies",
      label: documents && !launch.open ? "Add your legal pages" : "Publish legal pages",
      kind: "auto",
      done: documents && !launch.open ? closedPoliciesDone : publishedPoliciesDone,
      href: documents ? PAGES_LIST_HREF : "/admin/storefront",
      hint: documents ? policiesHint : "Privacy + terms/refund — templates scaffold them; checkout links them.",
      ...(documents ? { actions: policyActions(policy, { starters: !launch.open }) } : {}),
    },
    {
      id: "billing",
      label: "Activate billing",
      kind: "auto",
      done: Boolean(tenant.config?.billing),
      href: "/admin/billing",
      hint: "Pick a plan (Free counts) — explicit, never silent.",
    },
    {
      id: "domain",
      label: "Point your domain",
      kind: "auto",
      done: (tenant.domains || []).some(isRealDomain),
      href: "/admin/settings",
      hint: "A custom host (operator adds + verifies it).",
    },
    {
      id: "preview",
      label: "Review your draft preview",
      kind: "manual",
      done: Boolean(manual.preview),
      href: documents ? EDITOR_PATH : "/admin/storefront",
      hint: "Walk the storefront in the preview pane, then mark done.",
    },
    {
      id: "test_order",
      label: "Place a test order",
      kind: "manual",
      done: Boolean(manual.test_order),
      // a closed store's checkout opens only in the founder's preview (PUB-06)
      href: documents && !launch.open ? EDITOR_PATH : "/checkout",
      hint: documents && !launch.open ? TEST_ORDER_CLOSED_HINT : "One COD test order end-to-end (cancel it after).",
    },
  ];

  const prereqsDone = items.every((i) => i.done);
  if (documents) {
    // P4-PROVISION: the first publish IS the launch on the new editor, so the
    // step is read from the live state (no check-off) and links to Publish.
    items.push({
      id: "launch",
      label: "Launch",
      kind: "auto",
      done: launch.open,
      gated: false,
      href: EDITOR_PUBLISH_HREF,
      hint: launch.open ? LAUNCH_HINTS.open : prereqsDone ? LAUNCH_HINTS.closed : LAUNCH_HINTS.closedOpenSteps,
    });
    const doneCount = items.filter((i) => i.done).length;
    return {
      supported: true,
      items,
      doneCount,
      total: items.length,
      launched: launch.open,
      launchedAt: launch.open ? launch.since || manual.launch || null : null,
      provisionedAt: tenant.config?.onboarding?.provisioned_at || null,
    };
  }
  items.push({
    id: "launch",
    label: "Launch",
    kind: "manual",
    done: Boolean(manual.launch),
    gated: !prereqsDone && !manual.launch,
    href: documents ? EDITOR_PUBLISH_HREF : "/admin/releases",
    hint: prereqsDone || manual.launch ? (documents ? "Publish from the editor and go." : "Publish your first release and go.") : "Unlocks when everything above is done.",
  });

  const doneCount = items.filter((i) => i.done).length;
  return {
    supported: true,
    items,
    doneCount,
    total: items.length,
    launched: Boolean(manual.launch),
    launchedAt: manual.launch || null,
    provisionedAt: tenant.config?.onboarding?.provisioned_at || null,
  };
}

export const MANUAL_STEPS = ["preview", "test_order", "launch"];

export async function markManualStep(step, { done = true } = {}) {
  if (!MANUAL_STEPS.includes(step)) throw new Error(`"${step}" isn't a manual checklist step`);
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default") throw new Error("control-plane tenant required");
  if (step === "launch" && (await getCmsMode().catch(() => null)) === "documents") {
    throw new Error("On the new editor your store opens when you publish from the editor, so there is nothing to mark here.");
  }
  if (step === "launch" && done) {
    const { items } = await buildChecklist();
    const blocking = items.filter((i) => i.id !== "launch" && !i.done);
    if (blocking.length) throw new Error(`launch is gated — still open: ${blocking.map((i) => i.label).join(", ")}`);
  }
  const { patchTenant } = await import("../platform/control.js");
  const manual = { ...(tenant.config?.onboarding?.manual || {}) };
  if (done) manual[step] = new Date().toISOString();
  else delete manual[step];
  await patchTenant(tenant.id, { config: { onboarding: { ...(tenant.config?.onboarding || {}), manual } } });
  return { step, done };
}
