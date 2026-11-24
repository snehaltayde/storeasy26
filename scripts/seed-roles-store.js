// One command seeds a store with every role (Phase 0 line 5). The core of
// pnpm seed:roles: a fresh local store "roles" on roles.localhost with an
// owner, admin, staff and support member, an operator already enrolled in
// TOTP, a synced fixture catalog, and a shopper with one COD order. Nothing is
// published: the store stays closed until a founder publishes.
//
// Used by scripts/seed-roles.js (the child the roles harness runs, over its
// local sqld) and scripts/test-seed-roles.js (file: databases in a temp
// folder). Nothing here runs on import.
//
// Logins exist only in <dataDir>/roles-seed.json (mode 0600, folder 0700).
// Nothing returned or printed carries a password, a TOTP secret or a link.
//
// Refusals, each before anything is written:
//   - a Shopify store or payment key in the environment, or TURSO_DB_URL set
//   - any database URL that isn't file:<local path> or http://127.0.0.1|localhost|[::1]:<port>
//   - a roles-seed.json already in the data folder
//   - a platform database that already holds a tenant or a user, or a store
//     database that already holds tables
// The harness side (scripts/dev-roles.js, ROLES_PROFILE) adds: either harness
// running, and a .design-data-roles/ that already holds data (unless --reset,
// which deletes only that folder).
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR_NAME, HarnessError, holdsData, runningHarness } from "./design-harness.js";
import { REAL_KEYS, realKeysSet } from "./drills/p6/seed-p6.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const ROLES_DATA_DIR_NAME = ".design-data-roles";
export const ROLES_SEED_FILE = "roles-seed.json";
export const ROLES_STORE = Object.freeze({ id: "roles", name: "Roles Demo Co", host: "roles.localhost", port: 3018 });
export const rolesUrl = (port = ROLES_STORE.port, host = ROLES_STORE.host) => `http://${host}:${port}`;

export const ROLES_LOGINS = Object.freeze({
  members: Object.freeze([
    Object.freeze({ role: "owner", email: "owner@roles.test", name: "Olivia Owner" }),
    Object.freeze({ role: "admin", email: "admin@roles.test", name: "Arjun Admin" }),
    Object.freeze({ role: "staff", email: "staff@roles.test", name: "Sana Staff" }),
    Object.freeze({ role: "support", email: "support@roles.test", name: "Sam Support" }),
  ]),
  operator: Object.freeze({ email: "operator@roles.test", name: "Omar Operator" }),
  shopper: Object.freeze({
    email: "shopper@roles.test",
    name: "Meera Shopper",
    phone: "9800000001",
    address: Object.freeze({ line1: "12 Koregaon Park Road", line2: "Flat 4B", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" }),
  }),
});

// The roles harness profile (scripts/design-harness.js runHarness): its own
// folder and ports, never the design harness's.
export const ROLES_PROFILE = Object.freeze({
  name: "roles harness",
  dataDirName: ROLES_DATA_DIR_NAME,
  portEnv: Object.freeze({ next: "ROLES_PORT", sqld: "ROLES_SQLD_PORT" }),
  defaultPorts: Object.freeze({ next: ROLES_STORE.port, sqld: 18027 }),
  keepData: true,
  otherDataDirs: Object.freeze([DATA_DIR_NAME]),
  credentials: false,
  tenantId: ROLES_STORE.id,
  siteHost: ROLES_STORE.host,
  loginsFile: `${ROLES_DATA_DIR_NAME}/${ROLES_SEED_FILE}`,
  commands: Object.freeze({ dev: "pnpm dev:roles", seed: "pnpm seed:roles", rebuild: "pnpm seed:roles --reset" }),
});

// ---------- refusals ----------

const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
// The libsql client's own URL parser (@libsql/core, which @libsql/client
// ships with; not a new dependency), so the check reads a URL exactly the way
// the client that connects to it does.
const { parseUri } = createRequire(createRequire(import.meta.url).resolve("@libsql/client"))("@libsql/core/uri");

// file:<path> (or file:///<path>), or http on a loopback host with a port.
// Anything else (libsql://, https://, ws(s)://, file://host/..., a LAN
// address, userinfo, a path or query, a backslash, whitespace or a control
// character) is refused. Returns the URL rebuilt from its parsed parts, which
// is what every caller then uses. The message names only what is refused.
export function assertSeedDbUrl(name, url) {
  const text = String(url ?? "");
  const refuse = (why) => {
    throw new HarnessError(`${name} must be a local database (file:<path> or http://127.0.0.1:<port>); ${why}. The roles seed never writes anywhere else.`);
  };
  if (!text) refuse("it is empty");
  if (/[\\\s\x00-\x1f\x7f]/.test(text)) refuse("it has a backslash, a space or a control character");
  let u;
  try {
    u = parseUri(text);
  } catch {
    refuse("it isn't a URL");
  }
  const scheme = String(u.scheme).toLowerCase();
  const a = u.authority;
  if (u.query !== undefined || u.fragment !== undefined) refuse("it has a query or a fragment");
  if (scheme === "file") {
    if (a && (a.host || a.port !== undefined || a.userinfo)) refuse("file://<host>/ points at another machine");
    if (!u.path) refuse("it names no file");
    return `file:${u.path}`;
  }
  if (scheme !== "http" || !a) refuse(`it points at ${scheme}:`);
  if (a.userinfo) refuse("it carries a user name or password");
  if (!LOOPBACK.includes(a.host)) refuse(`it points at ${a.host || "no host"}`);
  if (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535) refuse("it has no port");
  if (u.path && u.path !== "/") refuse("it has a path");
  return `http://${a.host.includes(":") ? `[${a.host}]` : a.host}:${a.port}`;
}

export function assertSafeEnv(env = process.env) {
  const real = realKeysSet(env);
  if (real.length) throw new HarnessError(`Refusing to seed: the environment names a Shopify store or a payment key (${real.join(", ")}). The roles seed only runs with them blank.`);
  if (String(env.TURSO_DB_URL ?? "").trim()) throw new HarnessError("Refusing to seed: TURSO_DB_URL is set, so a store could open a hosted database. The roles seed only runs with it blank.");
}
export { REAL_KEYS };

// The roles data folder must be empty or missing; with reset, the plan says
// the folder (and only it) is deleted first. Nothing is deleted here.
export function assertFreshDataDir(dir, { reset = false } = {}) {
  const held = holdsData(dir);
  if (held && !reset) {
    throw new HarnessError(`${dir} already holds a store's data, and pnpm seed:roles never deletes it. pnpm seed:roles --reset deletes that folder (only that one) and seeds again; run it only if the data can go.`);
  }
  return { dir, holdsData: held, reset: Boolean(reset) && held };
}

// Neither harness may be running when the roles seed starts.
export function assertNoHarnessRunning(root = ROOT) {
  for (const name of [DATA_DIR_NAME, ROLES_DATA_DIR_NAME]) {
    const info = runningHarness(join(root, name));
    if (info) throw new HarnessError(`The harness using ${name}/ is running (pid ${info.launcher.pid}). Stop it with Ctrl-C in its terminal first, then seed again.`);
  }
}

// ---------- the seed ----------

const secretWord = (bytes = 12) => randomBytes(bytes).toString("base64url");
const NO_INDEX = async () => ({ indexed: 0 });

async function countOrZero(client, sql) {
  try {
    return Number((await client.execute(sql)).rows[0]?.n || 0);
  } catch {
    return 0; // the table isn't there yet: a fresh database
  }
}

// → summary (no password, TOTP secret or otpauth link). The logins go to
// <dataDir>/roles-seed.json only.
export async function seedRolesStore({ platformUrl, tenantUrl, defaultUrl, dataDir, host = ROLES_STORE.host, port = ROLES_STORE.port, env = process.env } = {}) {
  assertSafeEnv(env);
  const urls = {
    platform: assertSeedDbUrl("The platform database URL", platformUrl),
    tenant: assertSeedDbUrl("The store database URL", tenantUrl),
    default: assertSeedDbUrl("The default database URL", defaultUrl),
  };
  if (!dataDir) throw new HarnessError("seedRolesStore needs the data folder that receives roles-seed.json.");
  const seedFile = join(dataDir, ROLES_SEED_FILE);
  if (existsSync(seedFile)) throw new HarnessError(`Refusing to seed: ${dataDir} already holds a store (${ROLES_SEED_FILE} is there). Nothing was changed.`);

  const { createClient } = await import("@libsql/client");
  // Read-only checks first: a platform with any tenant or user, or a store
  // database with any table, already holds a store.
  for (const [key, url, sql] of [
    ["platform", urls.platform, "SELECT (SELECT count(*) FROM tenants) + (SELECT count(*) FROM users) AS n"],
    ["store", urls.tenant, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' AND name NOT LIKE '_litestream%'"],
  ]) {
    const c = createClient({ url });
    try {
      if ((await countOrZero(c, sql)) > 0) throw new HarnessError(`Refusing to seed: the ${key} database already holds a store. Nothing was changed.`);
    } finally {
      c.close();
    }
  }

  process.env.PLATFORM_DB_URL = urls.platform;
  process.env.PLATFORM_DB_TOKEN = "";
  process.env.DATABASE_URL = urls.default;
  const C = await import("../lib/platform/control.js");
  C.__resetPlatformClient();
  const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
  await C.migratePlatform(readFileSync(join(ROOT, "lib/platform/schema.sql"), "utf8"));
  await runMigrations(C.platformDb(), await loadMigrations("platform"), {});

  // the store's database, the way provisioning sets one up
  const P = await import("../lib/platform/provision.js");
  const tc = createClient({ url: urls.tenant });
  try {
    await P.applyTenantSchema(tc);
    const mode = await P.applyContentMode(tc, { contentMode: "documents" });
    if (mode.contentMode !== "documents") throw new Error(`the roles store did not start in documents mode: ${mode.contentModeReason}`);
  } finally {
    tc.close();
  }

  const siteUrl = rolesUrl(port, host);
  await C.upsertTenant({
    id: ROLES_STORE.id,
    name: ROLES_STORE.name,
    domains: [host],
    dbUrl: urls.tenant,
    config: {
      currency: "INR",
      merchant_timezone: "Asia/Kolkata",
      site_url: siteUrl,
      site: { name: ROLES_STORE.name },
      checkout_mode: "direct",
    },
    secrets: { admin_password: secretWord(), order_link_secret: randomBytes(32).toString("hex") },
  });
  const tenant = await C.getTenant(ROLES_STORE.id, { fresh: true });
  assertSeedDbUrl("The roles store's database", tenant.dbUrl);

  // members, a fresh password each seed
  const I = await import("../lib/platform/identity.js");
  const members = [];
  for (const m of ROLES_LOGINS.members) {
    const password = secretWord();
    const user = await I.createUser({ email: m.email, name: m.name, password });
    await I.addMembership(user.id, ROLES_STORE.id, m.role);
    members.push({ role: m.role, email: m.email, name: m.name, userId: user.id, password });
  }

  // the operator, enrolled in TOTP already
  const opPassword = secretWord();
  const op = await I.createOperator({ email: ROLES_LOGINS.operator.email, name: ROLES_LOGINS.operator.name, password: opPassword });
  const totpSecret = await I.ensureTotpSecret(op.id);
  await I.confirmTotp(op.id);
  const operator = { email: ROLES_LOGINS.operator.email, name: ROLES_LOGINS.operator.name, userId: op.id, password: opPassword, totpSecret, otpauth: I.totpUri(totpSecret, ROLES_LOGINS.operator.email) };

  // the catalog through the real sync, with the fixture as Shopify's answer
  const { catalogFor } = await import("./support/tenant-fixture.js");
  const { withTenant } = await import("../lib/tenant-context.js");
  const S = await import("../lib/sync.js");
  const cat = catalogFor("few");
  const sync = await withTenant(tenant, () => S.runCatalogSync({ fetchers: { products: async () => cat.products, collections: async () => cat.collections }, indexer: NO_INDEX, startedBy: "seed-roles" }));
  const confirmed = await withTenant(tenant, () => S.confirmedCatalogSync());
  if (!confirmed.confirmed) throw new Error(`the roles catalog sync is not confirmed (${confirmed.reason})`);

  // the shopper: a customer row and one COD order, priced by the server
  const shopperIn = ROLES_LOGINS.shopper;
  const shopper = await withTenant(tenant, async () => {
    const { db } = await import("../lib/db.js");
    const Cart = await import("../lib/cart.js");
    const O = await import("../lib/orders.js");
    const { computeShipping } = await import("../lib/shipping.js");
    const { tenantShippingConfig } = await import("../lib/tenant-context.js");
    const at = new Date().toISOString();
    const customerId = `cus_${randomBytes(8).toString("hex")}`;
    await db
      .insertInto("customers")
      .values({ id: customerId, email: shopperIn.email, name: shopperIn.name, phone: shopperIn.phone, default_address: JSON.stringify(shopperIn.address), created_at: at, last_login_at: null })
      .execute();
    const cartId = `cart_${randomBytes(12).toString("hex")}`;
    await Cart.createCart(cartId);
    await Cart.addItem(cartId, cat.products[0].variants.nodes[0].id, 2);
    await Cart.addItem(cartId, cat.products[1].variants.nodes[0].id, 1);
    const cart = await Cart.getCart(cartId);
    const shipping = computeShipping({ subtotal: cart.subtotal || 0, discountTotal: cart.discountTotal || 0, paymentMethod: "cod", pincode: shopperIn.address.pincode, config: tenantShippingConfig() });
    const order = await O.createOrder({
      cartId,
      paymentMethod: "cod",
      shipping,
      contact: { email: shopperIn.email, name: shopperIn.name, phone: shopperIn.phone },
      address: { ...shopperIn.address },
      idempotencyKey: `seed-roles-${randomBytes(8).toString("hex")}`,
    });
    await db.updateTable("orders").set({ customer_id: customerId }).where("id", "=", order.id).execute();
    await Cart.clearCart(cartId);
    return { email: shopperIn.email, name: shopperIn.name, customerId, orderId: order.id, total: Number(order.total), subtotal: Number(cart.subtotal), shippingTotal: Number(shipping.total), currency: order.currency };
  });

  const figures = { products: Number(sync?.products ?? cat.products.length), collections: Number(sync?.collections ?? cat.collections.length), syncRunId: confirmed.runId, syncStatus: "complete" };

  const { audit } = await import("../lib/platform/audit.js");
  await audit({
    actor: { kind: "cli", id: "seed-roles" },
    action: "seed.roles_store",
    tenantId: ROLES_STORE.id,
    diff: { members: members.length, operators: 1, shoppers: 1, orders: 1, products: figures.products, collections: figures.collections },
  });

  const seededAt = new Date().toISOString();
  writeRolesSeed(dataDir, {
    store: { id: ROLES_STORE.id, name: ROLES_STORE.name, host, url: siteUrl },
    members: members.map(({ role, email, name, password }) => ({ role, email, name, password })),
    operator: { email: operator.email, name: operator.name, password: operator.password, totpSecret: operator.totpSecret, otpauth: operator.otpauth },
    shopper: { email: shopper.email, name: shopper.name, orderId: shopper.orderId, signIn: "email code: pnpm roles:code prints the latest one" },
    catalog: figures,
    seededAt,
  });

  return {
    store: { id: ROLES_STORE.id, name: ROLES_STORE.name, host, url: siteUrl },
    members: members.map(({ role, email, userId }) => ({ role, email, userId })),
    operator: { email: operator.email, userId: operator.userId },
    shopper: { email: shopper.email, customerId: shopper.customerId, orderId: shopper.orderId, total: shopper.total, subtotal: shopper.subtotal, shippingTotal: shopper.shippingTotal, currency: shopper.currency },
    catalog: figures,
    file: seedFile,
    seededAt,
  };
}

// The one place logins are written: folder 0700, file 0600, never overwritten.
export function writeRolesSeed(dataDir, data) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const file = join(dataDir, ROLES_SEED_FILE);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return file;
}

// The line pnpm seed:roles prints: never a password, a secret or a link.
export function summaryLine(s) {
  const roles = s.members.map((m) => m.role).join(", ");
  const total = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(s.shopper.total);
  return `✓ roles store on ${s.store.url}: ${roles}, 1 operator, shopper with order ${s.shopper.orderId} (₹${total}, COD), ${s.catalog.products} products, sync complete. Store is closed (nothing published). Logins: ${ROLES_DATA_DIR_NAME}/${ROLES_SEED_FILE}`;
}

// The shopper's latest sign-in code, read from the store's notifications
// (the OTP mail is queued there; nothing is sent locally). Read only.
//   → { code, at } or null
export async function latestShopperCode({ tenantUrl, email = ROLES_LOGINS.shopper.email } = {}) {
  const url = assertSeedDbUrl("The store database URL", tenantUrl);
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url });
  try {
    const r = await c.execute({
      sql: "SELECT subject, created_at FROM notifications WHERE type = 'customer_otp' AND lower(recipient) = lower(?) ORDER BY created_at DESC LIMIT 1",
      args: [email],
    });
    const row = r.rows[0];
    const code = row ? String(row.subject || "").match(/\b(\d{6})\b/)?.[1] : null;
    return code ? { code, at: row.created_at } : null;
  } finally {
    c.close();
  }
}

// The Roles Annex (Phase 0 line 8, for drill:shell's store switcher): a second
// store on annex.localhost, on the roles harness's third ("default") database,
// with the roles store's owner as its admin and its support member as support.
// Run while the roles harness is up (node scripts/dev-roles.js annex). The
// seed's shape and roles-seed.json are unchanged; nothing is published.
export const ROLES_ANNEX = Object.freeze({ id: "annex", name: "Roles Annex", host: "annex.localhost" });
export const ANNEX_MEMBERS = Object.freeze([Object.freeze({ email: "owner@roles.test", role: "admin" }), Object.freeze({ email: "support@roles.test", role: "support" })]);
export async function addRolesAnnex({ platformUrl, annexUrl, port = ROLES_STORE.port, env = process.env } = {}) {
  assertSafeEnv(env);
  const urls = { platform: assertSeedDbUrl("The platform database URL", platformUrl), annex: assertSeedDbUrl("The annex database URL", annexUrl) };
  process.env.PLATFORM_DB_URL = urls.platform;
  process.env.PLATFORM_DB_TOKEN = "";
  const C = await import("../lib/platform/control.js");
  C.__resetPlatformClient();
  if (await C.getTenant(ROLES_ANNEX.id, { fresh: true })) throw new HarnessError("The Roles Annex is already there. Nothing was changed.");
  const I = await import("../lib/platform/identity.js");
  const users = [];
  for (const m of ANNEX_MEMBERS) {
    const u = await I.findUserByEmail(m.email);
    if (!u) throw new HarnessError(`The roles store has no ${m.email}: seed it first (pnpm seed:roles). Nothing was changed.`);
    users.push({ ...m, id: u.id });
  }
  const { createClient } = await import("@libsql/client");
  const P = await import("../lib/platform/provision.js");
  const c = createClient({ url: urls.annex });
  try {
    await P.applyTenantSchema(c);
    await P.applyContentMode(c, { contentMode: "documents" });
  } finally {
    c.close();
  }
  await C.upsertTenant({
    id: ROLES_ANNEX.id,
    name: ROLES_ANNEX.name,
    domains: [ROLES_ANNEX.host],
    dbUrl: urls.annex,
    config: { currency: "INR", merchant_timezone: "Asia/Kolkata", site_url: rolesUrl(port, ROLES_ANNEX.host), site: { name: ROLES_ANNEX.name }, checkout_mode: "direct" },
    secrets: { admin_password: secretWord(), order_link_secret: randomBytes(32).toString("hex") },
  });
  for (const u of users) await I.addMembership(u.id, ROLES_ANNEX.id, u.role);
  const { audit } = await import("../lib/platform/audit.js");
  await audit({ actor: { kind: "cli", id: "seed-roles" }, action: "seed.roles_annex", tenantId: ROLES_ANNEX.id, diff: { members: users.map((u) => `${u.email}:${u.role}`) } });
  return { store: { ...ROLES_ANNEX, url: rolesUrl(port, ROLES_ANNEX.host) }, members: users.map(({ email, role }) => ({ email, role })) };
}

// sha256 of a file's bytes (the test compares roles-seed.json across a refused re-run)
export const fileHash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
