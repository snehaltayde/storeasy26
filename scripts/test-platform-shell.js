// The operator shell and sign-in (Phase 3 line 0, docs/plans/phase-3.md "Line 0").
//   pnpm test:platform-shell
// No browser, no network. This suite proves:
//   1. the nav data (lib/platform/nav.js): the items, their order, the active
//      item by longest path prefix, and the account words
//   2. the sign-in's words: every server answer becomes plain words
//   3. app/(console)/platform/layout.js, run with its components stubbed, as
//      every caller: a TOTP operator and bootstrap-before get the shell with
//      the nav and their name and email; bootstrap-after, signed out, merchant
//      sessions, a merchant token in _platform, a non-operator's "operator"
//      session and revoked or expired sessions get the page alone, and nothing
//      they get holds a store id or name or the operator's email
//   4. the pages: /platform is the sign-in (or the "not set up" card) for
//      anyone not signed in and the Stores list for operators (the old console
//      at /platform/legacy went in Phase 3 line 7);
//      every other page (scripts/support/platform-pages.js) sends them to /platform
//   5. static: the new files import no components/console; the sign-in keeps
//      #pl-email, #pl-password and #pl-totp; the sidebar cookie is on /platform
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFile(join(ROOT, rel), "utf8");

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-platshell-default.db";
process.env.PLATFORM_SECRET = "test-platform-shell-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_ADMIN_PASSWORD = "bootstrap-pass-platshell";
const network = H.blockNetwork();

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${String(e?.stack || e?.message || e).split("\n").slice(0, 5).join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const started = Date.now();

const NAV = await import("../lib/platform/nav.js");
const W = await import("../components/platform/loginWords.js");
const { PLATFORM_PAGES, OPERATOR_ONLY_PAGES } = await import("./support/platform-pages.js");

// --- 1. nav --------------------------------------------------------------------
await t("nav: the full operator nav, in this exact order, each a /platform path; no Old console (Phase 3 line 7)", () => {
  eq(
    JSON.stringify(NAV.PLATFORM_NAV.map((i) => [i.id, i.label, i.href])),
    JSON.stringify([
      ["stores", "Stores", "/platform"],
      ["onboarding", "Signups & onboarding", "/platform/onboarding"],
      ["new-store", "New store", "/platform/stores/new"],
      ["flags", "Flags", "/platform/flags"],
      ["incidents", "Incidents", "/platform/incidents"],
      ["billing", "Billing", "/platform/billing"],
      ["operations", "Operations", "/platform/operations"],
      ["support-access", "Support access", "/platform/support-access"],
    ])
  );
  eq(new Set(NAV.PLATFORM_NAV.map((i) => i.id)).size, NAV.PLATFORM_NAV.length, "unique ids");
  for (const i of NAV.PLATFORM_NAV) ok(PLATFORM_PAGES.some((p) => p.path === i.href), `${i.href} is a listed page`);
});

await t("nav: the active item is the longest matching href", () => {
  const at = (p) => NAV.activePlatformItem(p)?.id ?? null;
  eq(at("/platform"), "stores");
  eq(at("/platform/onboarding"), "onboarding");
  eq(at("/platform/stores/new"), "new-store");
  eq(at("/platform/stores/some-store"), "stores", "a store's page is under Stores");
  eq(at("/platform/legacy"), "stores", "the old console's address is just under Stores now (the page is gone)");
  eq(at("/platform/stores/new?signup=x"), "stores", "a query is not a path (usePathname has none)");
  eq(at("/platformx"), null);
  eq(at("/admin"), null);
  eq(at(null), null);
});

await t("nav: the account words for an operator and for the setup password", () => {
  const op = NAV.operatorAccount({ id: "u_1", kind: "operator", name: "Asha", email: "asha@storeasy.test" });
  eq(op.name, "Asha");
  eq(op.email, "asha@storeasy.test");
  eq(op.note, null);
  const boot = NAV.operatorAccount({ id: "bootstrap", kind: "bootstrap", name: "Bootstrap operator", email: null });
  eq(boot.email, null);
  ok(/setup password/.test(boot.note), "the bootstrap note");
  eq(NAV.operatorAccount(null), null);
});

// --- 2. sign-in words ---------------------------------------------------------------
await t("sign-in: every server answer becomes plain words, never the raw message", () => {
  const cases = [
    [429, "Too many attempts — try again later", /Wait 15 minutes/],
    [503, "Platform console is not configured (set PLATFORM_ADMIN_PASSWORD)", /PLATFORM_ADMIN_PASSWORD/],
    [403, "Cross-origin request rejected", /another site/],
    [400, "Password required", /Enter your password/],
    [401, "That code didn't match — try the current code", /every 30 seconds/],
    [401, "Wrong authenticator code", /every 30 seconds/],
    [401, "Authenticator code required", /6-digit code/],
    [401, "Wrong email or password", /don't match an operator account/],
    [401, "Sign in with your operator email, password and code", /setup password is switched off/],
    [401, "Wrong password", /isn't the setup password/],
    [401, "", /couldn't sign you in/],
    [500, "boom", /on our side/],
  ];
  for (const [status, raw, want] of cases) {
    const words = W.loginError(status, raw);
    ok(want.test(words), `${status} "${raw}" -> "${words}"`);
    ok(!raw || status === 503 || !words.includes(raw), `${status}: the raw message is not shown`);
    ok(!/—/.test(words), `${status}: no em dash`);
  }
});

// --- 3. the layout, as every caller ----------------------------------------------------
const store = await H.makeRoleStore({ name: "platshell" });
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const AA = await import("../lib/platform/admin-auth.js");
const { makePageHarness } = await import("./support/page-harness.js");
const P = await makePageHarness({ tenant: async () => store.a.tenant });
const db = () => C.platformDb();

const operatorUser = store.users.operator;
await db().execute({ sql: "UPDATE users SET name = 'Drill Operator Asha' WHERE id = ?", args: [operatorUser.id] });
const opSession = async (userId, ttlMs = 10 * 60_000) => (await S.createSession({ userId, kind: "operator", ttlMs })).token;
const revoked = await opSession(operatorUser.id);
await S.revokeSessionByToken(revoked);
const bootstrap = await AA.platformSessionToken();
// P3-C: an operator's support tokens are never operator sessions. The support
// session (from the harness's cross-host entry) and a fresh, unspent support-entry
// token, each put in _platform, and the __Host-support cookie on its own.
const SP = await import("../lib/platform/support.js");
const supportSession = store.cookies["operator-support-entry"]["__Host-support"];
const supportEntry = (await SP.mintSupportEntry({ tenantId: store.a.id, operator: { kind: "operator", id: operatorUser.id }, consoleOrigin: H.CONSOLE_ORIGIN })).token;
// kept live for the whole run, so the 401 is the kind check and not the 60-second expiry
await db().execute({ sql: "UPDATE sessions SET expires_at = ? WHERE token_hash = ?", args: [new Date(Date.now() + 60 * 60_000).toISOString(), await S.sha256Hex(supportEntry)] });
const JARS = {
  operator: { _platform: await opSession(operatorUser.id) },
  "bootstrap-before": { _platform: bootstrap },
  "bootstrap-after": { _platform: bootstrap },
  "signed-out": {},
  "merchant-owner": store.cookies.owner,
  "merchant-support": store.cookies.support,
  "merchant-token-in-platform": { _platform: store.cookies.owner._admin },
  "non-operator-session": { _platform: await opSession(store.users.owner.id) },
  "revoked-operator": { _platform: revoked },
  "expired-operator": { _platform: await opSession(operatorUser.id, -60_000) },
  "support-session-in-platform": { _platform: supportSession },
  "support-entry-in-platform": { _platform: supportEntry },
  "host-support-only": { "__Host-support": supportSession },
};
const ALLOWED = ["operator", "bootstrap-before"];
const DENIED = Object.keys(JARS).filter((c) => !ALLOWED.includes(c));
async function withoutOperators(fn) {
  await db().execute({ sql: "UPDATE users SET is_operator = 0 WHERE id = ?", args: [operatorUser.id] });
  try {
    return await fn();
  } finally {
    await db().execute({ sql: "UPDATE users SET is_operator = 1 WHERE id = ?", args: [operatorUser.id] });
  }
}
const runAs = (caller, rel) => (caller === "bootstrap-before" ? withoutOperators(() => P.run(rel, { cookies: JARS[caller] })) : P.run(rel, { cookies: JARS[caller] }));
const CANARIES = [store.a.id, store.b.id, store.a.tenant.name, store.b.tenant.name, operatorUser.email, "Drill Operator Asha"].filter(Boolean).map(String);
const SHELL = "@/components/platform/shell/PlatformShell#PlatformShell";
const LAYOUT = "app/(console)/platform/layout.js";

await t("layout: a TOTP operator gets the shell with the nav, their name and email, and the sidebar cookie", async () => {
  const r = await runAs("operator", LAYOUT);
  ok(!r.error, String(r.error));
  eq(r.unresolved.length, 0, r.unresolved.join(", "));
  const shell = r.props.find((p) => p.component === SHELL);
  ok(shell, "the shell");
  eq(shell.props.nav, NAV.PLATFORM_NAV, "nav");
  eq(shell.props.account.name, "Drill Operator Asha", "name");
  eq(shell.props.account.email, operatorUser.email, "email");
  eq(shell.props.defaultOpen, true, "no sidebar_state cookie: open");
  const closed = await P.run(LAYOUT, { cookies: { ...JARS.operator, sidebar_state: "false" } });
  eq(closed.props.find((p) => p.component === SHELL)?.props.defaultOpen, false, "sidebar_state=false: closed");
});

await t("layout: bootstrap before the first operator gets the shell as the setup password", async () => {
  const r = await runAs("bootstrap-before", LAYOUT);
  const shell = r.props.find((p) => p.component === SHELL);
  ok(shell, "the shell");
  eq(shell.props.account.email, null, "no email");
  ok(/setup password/.test(shell.props.account.note), "the note");
});

await t("layout: every denied caller gets the page alone, with no shell and no store or operator name", async () => {
  for (const caller of DENIED) {
    const r = await runAs(caller, LAYOUT);
    ok(!r.error, `${caller}: ${r.error}`);
    ok(!r.props.some((p) => p.component === SHELL), `${caller}: no shell`);
    for (const c of CANARIES) ok(!r.text.includes(c), `${caller}: holds ${c}`);
  }
});

// --- 4. the pages ------------------------------------------------------------------
await t("pages: every app/(console)/platform page has its row in platform-pages.js", async () => {
  const pages = [];
  async function walk(dir) {
    for (const f of await readdir(dir)) {
      const p = join(dir, f);
      if ((await stat(p)).isDirectory()) await walk(p);
      else if (f === "page.js") pages.push(relative(ROOT, p).split("\\").join("/"));
    }
  }
  await walk(join(ROOT, "app/(console)/platform"));
  eq(pages.sort().join(","), PLATFORM_PAGES.map((p) => p.file).sort().join(","));
  eq(PLATFORM_PAGES.filter((p) => p.signIn).length, 1, "one sign-in page");
});

await t("pages: /platform is the sign-in for every denied caller, the Stores list for operators; /platform/legacy is gone", async () => {
  for (const caller of DENIED) {
    const r = await runAs(caller, "app/(console)/platform/page.js");
    ok(r.props.some((p) => p.component === "@/components/platform/PlatformLogin#default"), `${caller}: the sign-in`);
    for (const c of CANARIES) ok(!r.text.includes(c), `${caller}: holds ${c}`);
  }
  for (const caller of ALLOWED) {
    const r = await runAs(caller, "app/(console)/platform/page.js");
    ok(r.props.some((p) => p.component === "@/components/platform/stores/StoresTable#default"), `${caller}: the Stores list`);
  }
  for (const f of ["app/(console)/platform/legacy", "components/platform/PlatformAdmin.js", "components/console"]) {
    let gone = false;
    await stat(join(ROOT, f)).catch(() => (gone = true));
    ok(gone, `${f} is gone (Phase 3 line 7)`);
  }
});

const loginProps = (r) => r.props.find((p) => p.component === "@/components/platform/PlatformLogin#default")?.props;
async function noSetupPassword(fn) {
  const saved = process.env.PLATFORM_ADMIN_PASSWORD;
  process.env.PLATFORM_ADMIN_PASSWORD = "";
  try {
    return await fn();
  } finally {
    process.env.PLATFORM_ADMIN_PASSWORD = saved;
  }
}

await t("pages: no setup password and no operator account -> the \"not set up\" card", async () => {
  const r = await noSetupPassword(() => withoutOperators(() => P.run("app/(console)/platform/page.js", { cookies: {} })));
  eq(loginProps(r)?.configured, false, "configured=false");
});

await t("pages: no setup password but an operator account exists -> the sign-in, not \"not set up\"", async () => {
  const r = await noSetupPassword(() => P.run("app/(console)/platform/page.js", { cookies: {} }));
  ok(loginProps(r), "the sign-in");
  eq(loginProps(r).configured, undefined, "configured is not false");
});

await t("pages: no setup password and the operator lookup fails -> the sign-in (sign-in still fails closed)", async () => {
  const saved = process.env.PLATFORM_DB_URL;
  process.env.PLATFORM_DB_URL = "file:/nonexistent-dir-platshell/none.db";
  C.__resetPlatformClient({ preserveCaches: true });
  try {
    ok(await S.operatorsExist().then(() => false, () => true), "the operator lookup really fails here");
    const r = await noSetupPassword(() => P.run("app/(console)/platform/page.js", { cookies: {} }));
    ok(!r.error, String(r.error));
    ok(loginProps(r), "the sign-in");
    eq(loginProps(r).configured, undefined, "configured is not false");
  } finally {
    process.env.PLATFORM_DB_URL = saved;
    C.__resetPlatformClient({ preserveCaches: true });
  }
});

await t("pages: every operator-only page sends each denied caller to /platform and opens for operators", async () => {
  for (const path of OPERATOR_ONLY_PAGES) {
    const file = PLATFORM_PAGES.find((p) => p.path === path).file;
    for (const caller of DENIED) {
      const r = await runAs(caller, file);
      eq(r.redirect, "/platform", `${caller} at ${path}`);
    }
    for (const caller of ALLOWED) {
      const r = await runAs(caller, file);
      eq(r.redirect, null, `${caller} at ${path}`);
      ok(!r.error, `${caller} at ${path}: ${r.error}`);
    }
  }
});

// --- 5. static ------------------------------------------------------------------------
const NEW_FILES = ["components/platform/PlatformLogin.js", "components/platform/loginWords.js", "components/platform/shell/PlatformShell.js", "components/platform/shell/PlatformNav.js", "components/kit/copy-button.js", "lib/platform/nav.js", "lib/platform/require-operator.js", "app/(console)/platform/layout.js", "app/(console)/platform/page.js"];

await t("static: the new and rewritten files import nothing from components/console", async () => {
  for (const f of NEW_FILES) ok(!/from ["']@\/components\/console\//.test(await read(f)), f);
});

await t("static: the sign-in keeps #pl-email, #pl-password and #pl-totp, and shows the key with the kit's Copy", async () => {
  const src = await read("components/platform/PlatformLogin.js");
  for (const id of ["pl-email", "pl-password", "pl-totp"]) ok(src.includes(`id="${id}"`), id);
  ok(/import \{ CopyButton \} from "@\/components\/kit\/copy-button"/.test(src) && /<CopyButton id="pl-totp-secret" value=\{enroll\.secret\}/.test(src), "the key with Copy");
  ok(/configured = true/.test(src) && /LOGIN\.notConfiguredTitle/.test(src), "the not-set-up state");
  ok(/loginError\(res\.status, data\.error\)/.test(src), "errors in plain words");
});

await t("static: the shell keeps its sidebar cookie on /platform; the nav lives in lib/platform/nav.js", async () => {
  const shell = await read("components/platform/shell/PlatformShell.js");
  ok(/cookiePath="\/platform"/.test(shell), "cookiePath");
  ok(/\/api\/platform\/logout/.test(shell), "Sign out posts to the operator logout");
  ok(/from "@\/lib\/platform\/nav"/.test(await read("components/platform/shell/PlatformNav.js")), "PlatformNav reads lib/platform/nav.js");
});

await t("static: nothing a storefront route imports changes (require-operator and nav import no node:*)", async () => {
  for (const f of ["lib/platform/require-operator.js", "lib/platform/nav.js", "components/platform/loginWords.js"]) ok(!/from ["']node:/.test(await read(f)), f);
});

await t("no network: nothing reached fetch()", () => {
  eq(network.length, 0, `fetch calls: ${network.join(", ")}`);
});

await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
