// The team screen (docs/plans/phase-2.md "Line 8"): invite with a role, revoke,
// change a role, remove, transfer ownership; only an owner grants or changes
// ownership; invites can only raise a role and die when a member changes.
//   pnpm test:team
//   1. the route as every caller (support, the least-trusted, first): GET is
//      team.manage; owner invites, owner-invite revokes, owner changes and
//      transfer are team.owner; a role change on a non-member or another
//      store's user is 404 and writes no membership row
//   2. lib/platform/identity.js: the last-owner guard is one conditional
//      statement (two concurrent demotions of the only two owners leave one);
//      transferOwnership in one batch; revokeInvite; the raise-only accept
//   3. invites can't undo a change: a role change, removal or transfer expires
//      that member's pending invites, and the old token no longer works
//   4. the invite mail: sent through sendPlatformMail only when mail is set
//      up; a failed or unconfigured send says so (network blocked: nothing
//      leaves the machine)
//   5. audit rows for every write (team.owner for owner-related writes)
//   6. the page as support, staff, admin, owner and signed out (page-harness)
//   7. the screen's markup per role (Next's SWC, react-dom/server), and the words
// File databases only; outside services blanked, the network blocked.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-team-default.db";
process.env.PLATFORM_CACHE_MS = "50";
const netCalls = H.blockNetwork();

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  const [g, w] = [JSON.stringify(got), JSON.stringify(want)];
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const started = Date.now();

// --- the fixture ----------------------------------------------------------------
const store = await H.makeRoleStore({ name: "team" });
const { a, b, call, users } = store;
const I = await import("../lib/platform/identity.js");
const S = await import("../lib/platform/sessions.js");
const C = await import("../lib/platform/control.js");
const db = () => C.platformDb();
const one = async (sql, args = []) => {
  const r = await db().execute({ sql, args });
  return r.rows[0] ? { ...r.rows[0] } : null;
};
const roleOf = async (userId, tenantId = a.id) => (await one("SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?", [userId, tenantId]))?.role ?? null;
const membershipRows = async (userId) => Number((await one("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?", [userId])).n);
const lastAudit = (resource) => one("SELECT actor, action, tenant_id, resource, diff FROM audit_log WHERE resource = ? ORDER BY rowid DESC LIMIT 1", [resource]);
const tokenOf = (inviteUrl) => new URL(inviteUrl, "http://x").searchParams.get("token");
const inviteRow = (id) => one("SELECT * FROM invitations WHERE id = ?", [id]);
const live = (row) => row && !row.accepted_at && row.expires_at > new Date().toISOString();
let seq = 0;
// a new member of store A with its own session -> { user, jar }
async function member(role, { tenantId = a.id } = {}) {
  seq++;
  const user = await I.createUser({ email: `m${seq}-${role}@team.test`, password: `member-pass-${seq}` });
  await I.addMembership(user.id, tenantId, role);
  const token = (await S.createSession({ userId: user.id, kind: "merchant", ttlMs: 10 * 60_000 })).token;
  return { user, jar: { _admin: token } };
}
const post = (caller, body, opts = {}) => call(caller, "team", "POST", { body, ...opts });
const as = (m, body) => call("custom", "team", "POST", { body, cookies: m.jar });

console.log("— 1. the route, every caller");
await t("support, staff and signed out: GET is 403, 403, 401 and the body holds no email", async () => {
  for (const [caller, status] of [["support", 403], ["operator-support", 403], ["staff", 403], ["signed-out", 401], ["owner-b", 401]]) {
    const r = await call(caller, "team", "GET");
    eq(r.status, status, `${caller}:`);
    ok(!/@/.test(r.text), `${caller} sees no email:`);
  }
  const ownerView = await call("owner", "team", "GET");
  eq([ownerView.status, ownerView.body.supported], [200, true]);
  ok(ownerView.body.members.some((m) => m.email === users.support.email), "the owner sees the members:");
});
await t("support and staff can't invite, revoke, change, remove or transfer (403, nothing written)", async () => {
  const before = Number((await one("SELECT COUNT(*) AS n FROM invitations")).n);
  for (const caller of ["support", "staff", "operator-support"]) {
    for (const body of [
      { action: "invite", email: "x@team.test", role: "staff" },
      { action: "revoke-invite", inviteId: "i_missing" },
      { action: "role", userId: "$admin", role: "staff" },
      { action: "remove", userId: "$admin" },
      { action: "transfer", userId: "$admin", confirm: a.tenant.name },
    ]) eq((await post(caller, body)).status, 403, `${caller} ${body.action}:`);
  }
  eq(Number((await one("SELECT COUNT(*) AS n FROM invitations")).n), before, "no invite written:");
  eq([await roleOf(users.admin.id), await roleOf(users.owner.id)], ["admin", "owner"]);
});
await t("owner invites: an admin inviting an owner is 403; the owner is 200 with the link once", async () => {
  const refused = await post("admin", { action: "invite", email: "boss@team.test", role: "owner" });
  eq(refused.status, 403);
  eq(await one("SELECT id FROM invitations WHERE email = 'boss@team.test'"), null, "no invite row:");
  const r = await post("owner", { action: "invite", email: "boss@team.test", role: "owner" });
  eq(r.status, 200);
  ok(/^\/admin\/accept-invite\?token=[0-9a-f]{64}$/.test(r.body.inviteUrl), "the link:");
  ok(r.body.invites.some((i) => i.email === "boss@team.test" && i.role === "owner"), "listed:");
  ok(!JSON.stringify(r.body.invites).includes(tokenOf(r.body.inviteUrl)), "the list never holds the token:");
});
await t("revoke: an admin revoking an owner invite is 403 and the invite stays; the owner revokes it", async () => {
  const inv = (await call("owner", "team", "GET")).body.invites.find((i) => i.email === "boss@team.test");
  ok(inv, "the owner invite:");
  eq((await post("admin", { action: "revoke-invite", inviteId: inv.id })).status, 403, "admin:");
  ok(live(await inviteRow(inv.id)), "still live:");
  const r = await post("owner", { action: "revoke-invite", inviteId: inv.id });
  eq(r.status, 200, "owner:");
  ok(!live(await inviteRow(inv.id)) && !r.body.invites.some((i) => i.id === inv.id), "revoked and gone from the list:");
  eq((await post("owner", { action: "revoke-invite", inviteId: inv.id })).status, 404, "twice:");
  eq((await post("owner", { action: "revoke-invite", inviteId: "i_missing" })).status, 404, "unknown:");
});
await t("revoke: an admin revokes a staff invite; another store's invite is 404 there and stays live", async () => {
  const r = await post("admin", { action: "invite", email: "helper@team.test", role: "staff" });
  eq(r.status, 200);
  const inv = r.body.invites.find((i) => i.email === "helper@team.test");
  eq((await post("admin", { action: "revoke-invite", inviteId: inv.id })).status, 200);
  ok(!live(await inviteRow(inv.id)), "revoked:");
  const theirs = await I.createInvite({ email: "elsewhere@team.test", tenantId: b.id, role: "staff" });
  eq((await post("owner", { action: "revoke-invite", inviteId: theirs.id })).status, 404, "store B's invite:");
  ok(live(await inviteRow(theirs.id)), "store B's invite still live:");
});
await t("owner protection: an admin changing or removing an owner is 403; demoting or removing the last owner is 422", async () => {
  eq((await post("admin", { action: "role", userId: "$owner", role: "staff" })).status, 403);
  eq((await post("admin", { action: "remove", userId: "$owner" })).status, 403);
  eq((await post("admin", { action: "role", userId: "$staff", role: "owner" })).status, 403, "admin granting owner:");
  const demote = await post("owner", { action: "role", userId: "$owner", role: "admin" });
  eq(demote.status, 422);
  ok(/last owner/.test(demote.body.error), "plain words:");
  eq((await post("owner", { action: "remove", userId: "$owner" })).status, 422);
  eq(await roleOf(users.owner.id), "owner");
});
await t("non-member: a role change on a user with no membership here is 404 and writes no membership row", async () => {
  const stranger = await I.createUser({ email: "stranger@team.test", password: "stranger-pass-1" });
  for (const role of ["staff", "support", "admin"]) {
    const r = await post("admin", { action: "role", userId: stranger.id, role });
    eq(r.status, 404, `${role}:`);
  }
  eq((await post("owner", { action: "role", userId: stranger.id, role: "owner" })).status, 404, "owner granting owner:");
  eq(await membershipRows(stranger.id), 0, "no membership row:");
  eq((await post("owner", { action: "remove", userId: stranger.id })).status, 404, "remove:");
});
await t("another store's user: role, remove and transfer are 404 and change nothing in either store", async () => {
  for (const body of [
    { action: "role", userId: "$owner-b", role: "staff" },
    { action: "role", userId: "$owner-b", role: "owner" },
    { action: "remove", userId: "$owner-b" },
    { action: "transfer", userId: "$owner-b", confirm: a.tenant.name },
  ]) eq((await post("owner", body)).status, 404, body.action);
  eq([await roleOf(users["owner-b"].id, a.id), await roleOf(users["owner-b"].id, b.id), await roleOf(users.owner.id)], [null, "owner", "owner"]);
});
await t("no remove on your own row; an admin changes non-owners among admin, staff and support", async () => {
  eq((await post("admin", { action: "remove", userId: "$admin" })).status, 422, "own row:");
  const m = await member("staff");
  for (const role of ["support", "admin", "staff"]) {
    eq((await post("admin", { action: "role", userId: m.user.id, role })).status, 200, role);
    eq(await roleOf(m.user.id), role);
  }
  eq((await post("admin", { action: "remove", userId: m.user.id })).status, 200, "remove:");
  eq(await roleOf(m.user.id), null);
});

console.log("— 2. identity: the guard, transfer, revoke");
await t("atomic guard: two concurrent demotions of the only two owners leave exactly one owner (route)", async () => {
  const second = await member("owner");
  const [x, y] = await Promise.all([
    post("owner", { action: "role", userId: second.user.id, role: "admin" }),
    as(second, { action: "role", userId: users.owner.id, role: "admin" }),
  ]);
  // the loser is 422 (the guard) or 403 (already demoted when its own request was checked)
  eq([x.status, y.status].filter((s) => s === 200).length, 1, "one succeeds:");
  ok([x.status, y.status].every((s) => [200, 403, 422].includes(s)), `the other is refused (${x.status}, ${y.status}):`);
  eq(await I.countOwners(a.id), 1, "one owner left:");
  // put it back: whoever is still owner makes the other owner again, then the extra one goes
  const left = (await roleOf(users.owner.id)) === "owner" ? "owner" : second;
  if (left === "owner") await I.removeMembership(second.user.id, a.id);
  else {
    await I.addMembership(users.owner.id, a.id, "owner");
    await I.removeMembership(second.user.id, a.id);
  }
  eq([await roleOf(users.owner.id), await I.countOwners(a.id)], ["owner", 1]);
});
await t("atomic guard: concurrent demote and remove of two owners in identity.js (addMembership, setMemberRole, removeMembership) leave one", async () => {
  const p = await member("owner", { tenantId: b.id });
  const q = users["owner-b"];
  for (const [f, g] of [
    [() => I.addMembership(p.user.id, b.id, "admin"), () => I.addMembership(q.id, b.id, "admin")],
    [() => I.setMemberRole(p.user.id, b.id, "staff"), () => I.setMemberRole(q.id, b.id, "staff")],
    [() => I.removeMembership(p.user.id, b.id), () => I.removeMembership(q.id, b.id)],
    [() => I.removeMembership(p.user.id, b.id), () => I.setMemberRole(q.id, b.id, "support")],
  ]) {
    await I.addMembership(p.user.id, b.id, "owner");
    await I.addMembership(q.id, b.id, "owner");
    const settled = await Promise.allSettled([f(), g()]);
    eq(settled.map((s) => s.status).sort(), ["fulfilled", "rejected"], "one refused:");
    ok(/last owner/.test(settled.find((s) => s.status === "rejected").reason.message), "the last-owner words:");
    eq(await I.countOwners(b.id), 1, "one owner left:");
  }
  await I.addMembership(q.id, b.id, "owner");
  await I.addMembership(p.user.id, b.id, "staff");
  await I.removeMembership(p.user.id, b.id);
});
await t("owner-target guard: a non-owner's demote or remove never lands on a member promoted to owner (identity, the forced order)", async () => {
  const x = await member("staff");
  await I.setMemberRole(x.user.id, a.id, "owner"); // the owner's promotion lands first
  for (const write of [() => I.setMemberRole(x.user.id, a.id, "support", { ownerTargets: false }), () => I.removeMembership(x.user.id, a.id, { ownerTargets: false })]) {
    let threw = null;
    await write().catch((e) => (threw = e));
    eq(threw?.code, "OWNER_TARGET", "refused in the statement:");
    eq(await roleOf(x.user.id), "owner", "X stays owner:");
  }
  eq(await I.setMemberRole(x.user.id, a.id, "staff", { ownerTargets: false }).catch((e) => e.code), "OWNER_TARGET");
  await I.setMemberRole(x.user.id, a.id, "staff");
  eq(await I.setMemberRole(x.user.id, a.id, "support", { ownerTargets: false }), "support", "a non-owner row still changes:");
  await I.removeMembership(x.user.id, a.id);
});
for (const [label, adminBody] of [
  ["demotes", (x) => ({ action: "role", userId: x.user.id, role: "support" })],
  ["removes", (x) => ({ action: "remove", userId: x.user.id })],
]) {
  await t(`race: the owner promotes X while an admin ${label} X; X never ends up changed by the admin after becoming owner (route, 8 rounds)`, async () => {
    for (let i = 0; i < 8; i++) {
      const x = await member("staff");
      const [promote, adminRes] = await Promise.all([post("owner", { action: "role", userId: x.user.id, role: "owner" }), post("admin", adminBody(x))]);
      const now = await roleOf(x.user.id);
      if (promote.status === 200 && now === "owner") ok([403].includes(adminRes.status) || adminRes.status === 200, `round ${i}: admin ${adminRes.status}`);
      // the admin's write may only have landed before the promotion: then the owner's promote follows (X owner) or found no member (404)
      ok(now === "owner" || (label === "removes" && now === null && promote.status === 404 && adminRes.status === 200), `round ${i}: X is ${now} (promote ${promote.status}, admin ${adminRes.status})`);
      if (adminRes.status === 200 && now === "owner") ok(promote.status === 200, `round ${i}: the admin went first, then the promotion:`);
      if (now) {
        await I.setMemberRole(x.user.id, a.id, "staff");
        await I.removeMembership(x.user.id, a.id);
      }
    }
    eq(await roleOf(users.owner.id), "owner");
  });
}
await t("setMemberRole: a non-member is null and no row; a member's role changes; the last owner is refused", async () => {
  const stranger = await I.createUser({ email: "stranger2@team.test", password: "stranger-pass-2" });
  eq(await I.setMemberRole(stranger.id, a.id, "owner"), null);
  eq(await membershipRows(stranger.id), 0);
  const m = await member("support");
  eq(await I.setMemberRole(m.user.id, a.id, "staff"), "staff");
  let threw = null;
  await I.setMemberRole(users.owner.id, a.id, "admin").catch((e) => (threw = e));
  ok(threw && /last owner/.test(threw.message), "refused:");
  await I.removeMembership(m.user.id, a.id);
});
await t("transferOwnership: one batch; the target becomes owner, the caller admin; a non-member or a non-owner caller changes nothing", async () => {
  const m = await member("admin", { tenantId: b.id });
  const stranger = await I.createUser({ email: "stranger3@team.test", password: "stranger-pass-3" });
  eq(await I.transferOwnership(users["owner-b"].id, stranger.id, b.id), false, "non-member:");
  eq([await roleOf(users["owner-b"].id, b.id), await membershipRows(stranger.id)], ["owner", 0]);
  eq(await I.transferOwnership(m.user.id, users["owner-b"].id, b.id), false, "a non-owner caller:");
  eq(await I.transferOwnership(users["owner-b"].id, m.user.id, b.id), true);
  eq([await roleOf(m.user.id, b.id), await roleOf(users["owner-b"].id, b.id), await I.countOwners(b.id)], ["owner", "admin", 1]);
  eq(await I.transferOwnership(m.user.id, users["owner-b"].id, b.id), true, "back:");
  await I.removeMembership(m.user.id, b.id);
  ok(/\.batch\(\s*\[/.test(read("lib/platform/identity.js")), "a batch:");
});
await t("revokeInvite: only a live invite of this store; -> the row or null", async () => {
  const mine = await I.createInvite({ email: "r1@team.test", tenantId: a.id, role: "staff" });
  const theirs = await I.createInvite({ email: "r2@team.test", tenantId: b.id, role: "staff" });
  eq(await I.revokeInvite(theirs.id, a.id), null, "another store:");
  ok(live(await inviteRow(theirs.id)));
  eq((await I.revokeInvite(mine.id, a.id))?.email, "r1@team.test");
  ok(!live(await inviteRow(mine.id)));
  eq(await I.revokeInvite(mine.id, a.id), null, "twice:");
  eq(await I.acceptInvite({ token: mine.token, name: "R", password: "a-strong-pass-1", tenantId: a.id }), null, "a revoked token can't be accepted:");
});
await t("raise-only accept: at or below the held role is alreadyMember with the role kept and the token spent; a raising invite raises", async () => {
  const m = await member("admin");
  const pw = `member-pass-${seq}`;
  for (const role of ["admin", "staff", "support"]) {
    const inv = await I.createInvite({ email: m.user.email, tenantId: a.id, role });
    eq(await I.acceptInvite({ token: inv.token, password: pw, tenantId: a.id }), { alreadyMember: true }, role);
    eq(await roleOf(m.user.id), "admin");
    ok((await inviteRow(inv.id)).accepted_at, "spent:");
  }
  const up = await I.createInvite({ email: m.user.email, tenantId: a.id, role: "owner" });
  eq((await I.acceptInvite({ token: up.token, password: pw, tenantId: a.id }))?.inviteRole, "owner");
  eq(await roleOf(m.user.id), "owner");
  await I.setMemberRole(m.user.id, a.id, "staff");
  await I.removeMembership(m.user.id, a.id);
});

console.log("— 3. invites can't undo a change");
for (const [label, act] of [
  ["a role change", (m) => post("owner", { action: "role", userId: m.user.id, role: "support" })],
  ["a removal", (m) => post("owner", { action: "remove", userId: m.user.id })],
  ["a transfer", (m) => post("owner", { action: "transfer", userId: m.user.id, confirm: a.tenant.name })],
]) {
  await t(`${label} expires that member's pending invites and the old token no longer works`, async () => {
    const m = await member("staff");
    const r = await post("owner", { action: "invite", email: m.user.email, role: "admin" });
    eq(r.status, 200);
    const inv = r.body.invites.find((i) => i.email === m.user.email);
    const res = await act(m);
    eq(res.status, 200, `${label}:`);
    ok(!live(await inviteRow(inv.id)), "expired:");
    ok(!res.body.invites.some((i) => i.id === inv.id), "the list refreshed:");
    eq(await I.acceptInvite({ token: tokenOf(r.body.inviteUrl), password: `member-pass-${seq}`, tenantId: a.id }), null, "the old token:");
    if (label === "a transfer") {
      // the caller is admin now and the member owner: give it back through the route as the new owner
      eq([await roleOf(m.user.id), await roleOf(users.owner.id)], ["owner", "admin"]);
      eq((await as(m, { action: "transfer", userId: users.owner.id, confirm: a.tenant.name })).status, 200, "back:");
    }
    if (await roleOf(m.user.id)) await I.removeMembership(m.user.id, a.id);
    eq(await roleOf(users.owner.id), "owner");
  });
}

console.log("— 3b. transfer");
await t("transfer: an admin is 403; to a non-member 404; to yourself 422; a wrong store name 422; nothing changes", async () => {
  const m = await member("staff");
  eq((await post("admin", { action: "transfer", userId: m.user.id, confirm: a.tenant.name })).status, 403, "admin:");
  const stranger = await I.createUser({ email: "stranger4@team.test", password: "stranger-pass-4" });
  eq((await post("owner", { action: "transfer", userId: stranger.id, confirm: a.tenant.name })).status, 404, "non-member:");
  eq((await post("owner", { action: "transfer", userId: "$owner", confirm: a.tenant.name })).status, 422, "yourself:");
  const wrong = await post("owner", { action: "transfer", userId: m.user.id, confirm: "not the name" });
  eq(wrong.status, 422, "wrong name:");
  ok(/store name/i.test(wrong.body.error), "says so:");
  eq([await roleOf(m.user.id), await roleOf(users.owner.id), await membershipRows(stranger.id)], ["staff", "owner", 0]);
  await I.removeMembership(m.user.id, a.id);
});
await t("transfer by the owner: the target is owner, the caller admin; the caller's next GET still works as admin, an owner action is 403", async () => {
  const m = await member("admin");
  const r = await post("owner", { action: "transfer", userId: m.user.id, confirm: ` ${a.tenant.name.toUpperCase()} ` });
  eq(r.status, 200);
  eq(r.body.you?.role, "admin", "the answer says your new role:");
  eq([await roleOf(m.user.id), await roleOf(users.owner.id)], ["owner", "admin"]);
  eq((await call("owner", "team", "GET")).status, 200, "admin reads the team:");
  eq((await post("owner", { action: "invite", email: "boss2@team.test", role: "owner" })).status, 403, "no owner action any more (a fresh lookup):");
  eq((await as(m, { action: "transfer", userId: users.owner.id, confirm: a.tenant.name })).status, 200, "back:");
  await I.removeMembership(m.user.id, a.id);
  eq(await roleOf(users.owner.id), "owner");
});

await t("race: a transfer to X while an admin removes X: either X owns the store and stays, or the transfer is refused and the owner keeps it (8 rounds)", async () => {
  for (let i = 0; i < 8; i++) {
    const x = await member("admin");
    const [tr, rm] = await Promise.all([post("owner", { action: "transfer", userId: x.user.id, confirm: a.tenant.name }), post("admin", { action: "remove", userId: x.user.id })]);
    const [xr, or] = [await roleOf(x.user.id), await roleOf(users.owner.id)];
    if (tr.status === 200) eq([xr, or, rm.status], ["owner", "admin", 403], `round ${i}: transfer won:`);
    else {
      ok([404, 409].includes(tr.status) && rm.status === 200, `round ${i}: removal won (${tr.status}, ${rm.status}):`);
      eq([xr, or], [null, "owner"], `round ${i}:`);
    }
    eq(await I.countOwners(a.id), 1, `round ${i}: one owner:`);
    if (tr.status === 200) eq((await as(x, { action: "transfer", userId: users.owner.id, confirm: a.tenant.name })).status, 200, "back:");
    if (await roleOf(x.user.id)) await I.removeMembership(x.user.id, a.id);
  }
});
await t("transfer: the store name check folds case and inner spaces; a store with no name asks for its id, never 'null'", async () => {
  const m = await member("admin");
  const rename = async (name) => {
    await db().execute({ sql: "UPDATE tenants SET name = ? WHERE id = ?", args: [name, a.id] });
    await new Promise((r) => setTimeout(r, 80)); // PLATFORM_CACHE_MS
  };
  try {
    await rename("Team  Demo Co");
    eq((await post("owner", { action: "transfer", userId: m.user.id, confirm: "Team Demo" })).status, 422, "a part of the name:");
    eq((await post("owner", { action: "transfer", userId: m.user.id, confirm: "  team   demo\tco " })).status, 200, "case and inner spaces folded:");
    eq((await as(m, { action: "transfer", userId: users.owner.id, confirm: "TEAM DEMO CO" })).status, 200, "back:");
    await rename("");
    const r = await post("owner", { action: "transfer", userId: m.user.id, confirm: "x" });
    eq(r.status, 422);
    ok(r.body.error.includes(a.id) && !/null|undefined/.test(r.body.error), `the id in the words: ${r.body.error}`);
  } finally {
    await rename(a.tenant.name);
    await I.removeMembership(m.user.id, a.id);
  }
  eq(await roleOf(users.owner.id), "owner");
});
await t("revoke: an admin sending another store's owner invite id is 404 and that invite stays live", async () => {
  const theirs = await I.createInvite({ email: "b-owner@team.test", tenantId: b.id, role: "owner" });
  eq((await post("admin", { action: "revoke-invite", inviteId: theirs.id })).status, 404);
  ok(live(await inviteRow(theirs.id)));
});

console.log("— 4. the invite mail");
await t("mail not set up: nothing is sent, no platform_mail row, the answer says to send the link yourself", async () => {
  const r = await post("owner", { action: "invite", email: "nomail@team.test", role: "staff" });
  eq(r.status, 200);
  eq(r.body.mail, { status: "not-configured" });
  eq(await one("SELECT id FROM platform_mail WHERE recipient = 'nomail@team.test'"), null);
});
await t("mail set up but the send fails (network blocked): the link is still shown, the answer says it failed, the platform_mail row is failed with no body", async () => {
  process.env.RESEND_API_KEY = "re_test_blocked";
  const callsBefore = netCalls.length;
  try {
    const logged = [];
    const orig = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = (...x) => logged.push(x.map(String).join(" "));
    let r;
    try {
      r = await post("owner", { action: "invite", email: "mailfail@team.test", role: "support" });
    } finally {
      [console.log, console.error, console.warn] = orig;
    }
    const token = tokenOf(r.body.inviteUrl);
    ok(logged.some((l) => /team_invite_mail_failed/.test(l)), "the failure is logged:");
    ok(token && logged.every((l) => !l.includes(token)), "no log line holds the token:");
    ok(!String((await one("SELECT error FROM platform_mail WHERE recipient = 'mailfail@team.test'"))?.error || "").includes(token), "nor the mail row's error:");
    eq(r.status, 200);
    ok(r.body.inviteUrl, "the link:");
    eq(r.body.mail?.status, "failed");
    const row = await one("SELECT kind, status, body FROM platform_mail WHERE recipient = 'mailfail@team.test'");
    eq([row.kind, row.status, row.body], ["team_invite", "failed", null]);
    ok(netCalls.length > callsBefore && netCalls.slice(callsBefore).every((u) => /resend/.test(u)), "only the blocked provider call:");
  } finally {
    process.env.RESEND_API_KEY = "";
  }
});

// P2-G: an invite only ever raises a role, so one for a member already at or
// above it is refused before anything is written or sent
await t("P2-G inviting an existing member at or above the invited role is 409 ALREADY_MEMBER: no invitation row, no mail, no audit row", async () => {
  process.env.RESEND_API_KEY = "re_test_blocked"; // mail set up: a send would show as a call and a platform_mail row
  try {
    for (const [have, invited] of [["staff", "staff"], ["staff", "support"], ["admin", "staff"], ["admin", "admin"], ["owner", "admin"]]) {
      const m = await member(have);
      const callsBefore = netCalls.length;
      const r = await post("owner", { action: "invite", email: m.user.email.toUpperCase(), role: invited });
      eq([r.status, r.body?.code], [409, "ALREADY_MEMBER"], `${have} invited as ${invited}:`);
      ok(r.body?.error && !r.body.inviteUrl, `${have} as ${invited}: plain words, no link`);
      eq(await one("SELECT id FROM invitations WHERE email = ?", [m.user.email]), null, `${have} as ${invited}: invitation row`);
      eq(await one("SELECT id FROM platform_mail WHERE recipient = ?", [m.user.email]), null, `${have} as ${invited}: mail row`);
      eq(netCalls.length, callsBefore, `${have} as ${invited}: a mail send was tried`);
      eq(await lastAudit(`invite:${m.user.email}`), null, `${have} as ${invited}: audit row`);
      eq(await roleOf(m.user.id), have, `${have} as ${invited}: the role is unchanged`);
    }
    // staff and support hold no team.manage: 403 before any membership lookup, never the 409
    const existing = await member("staff");
    for (const caller of ["staff", "support"]) {
      const r = await post(caller, { action: "invite", email: existing.user.email, role: "staff" });
      eq(r.status, 403, `${caller} inviting an existing member:`);
      ok(r.body?.code !== "ALREADY_MEMBER" && !r.text.includes(existing.user.email), `${caller}: no membership answer`);
    }
    eq(await one("SELECT id FROM invitations WHERE email = ?", [existing.user.email]), null, "no row for the refused callers:");
    // a raise is still an invite (the positive control)
    const m = await member("support");
    const up = await post("owner", { action: "invite", email: m.user.email, role: "staff" });
    eq(up.status, 200, "support invited as staff:");
    ok(await one("SELECT id FROM invitations WHERE email = ?", [m.user.email]), "the raise's invitation row:");
  } finally {
    process.env.RESEND_API_KEY = "";
  }
});

console.log("— 5. audit");
await t("every write writes an audit row; owner-related writes are team.owner, the rest team.manage", async () => {
  const m = await member("staff");
  const inv = await post("admin", { action: "invite", email: "audited@team.test", role: "support" });
  eq((await lastAudit("invite:audited@team.test")).action, "team.manage");
  const id = inv.body.invites.find((i) => i.email === "audited@team.test").id;
  await post("admin", { action: "revoke-invite", inviteId: id });
  eq((await lastAudit(`invite-revoked:${id}`))?.action, "team.manage", "revoke:");
  await post("owner", { action: "invite", email: "audited-owner@team.test", role: "owner" });
  eq((await lastAudit("invite:audited-owner@team.test")).action, "team.owner");
  const oid = (await call("owner", "team", "GET")).body.invites.find((i) => i.email === "audited-owner@team.test").id;
  await post("owner", { action: "revoke-invite", inviteId: oid });
  eq((await lastAudit(`invite-revoked:${oid}`))?.action, "team.owner", "owner invite revoke:");
  await post("admin", { action: "role", userId: m.user.id, role: "support" });
  eq((await lastAudit(`member:${m.user.id}`)).action, "team.manage");
  await post("owner", { action: "role", userId: m.user.id, role: "owner" });
  eq((await lastAudit(`member:${m.user.id}`)).action, "team.owner", "grant owner:");
  await post("owner", { action: "role", userId: m.user.id, role: "staff" });
  eq((await lastAudit(`member:${m.user.id}`)).action, "team.owner", "change an owner:");
  await post("owner", { action: "transfer", userId: m.user.id, confirm: a.tenant.name });
  const tr = await lastAudit(`ownership:${users.owner.id}→${m.user.id}`);
  eq([tr?.action, tr?.actor, tr?.tenant_id], ["team.owner", users.owner.id, a.id], "transfer:");
  await as(m, { action: "transfer", userId: users.owner.id, confirm: a.tenant.name });
  await post("owner", { action: "remove", userId: m.user.id });
  eq((await lastAudit(`member:${m.user.id}`)).action, "team.manage", "remove (an admin again):");
});

console.log("— 6. the page");
const { makePageHarness } = await import("./support/page-harness.js");
const pages = await makePageHarness({ tenant: () => C.getTenant(a.id, { fresh: true }) });
const PAGE = "app/(console)/admin/(authed)/settings/team/page.js";
const CANARY = users.support.email;
await t("as support and staff the page is the no-access page: no props at all, no email anywhere (canary)", async () => {
  for (const caller of ["support", "staff", "operator-support"]) {
    const run = await pages.run(PAGE, { cookies: store.cookies[caller] });
    eq([run.error?.message ?? null, run.unresolved, run.redirect ?? null], [null, [], null], `${caller}:`);
    ok(run.props.some((p) => p.component.endsWith("#TeamNoAccess")) && !run.props.some((p) => p.component.endsWith("#TeamPage")), `${caller} gets TeamNoAccess:`);
    const all = JSON.stringify(run.props.map((p) => p.props)) + (run.text || "");
    ok(!all.includes(CANARY) && !/[\w.+-]+@[\w-]+\.\w+/.test(all), `${caller}: no email in the page:`);
  }
  eq((await pages.run(PAGE, { cookies: {} })).redirect, "/admin/login", "signed out:");
});
await t("as admin and owner the page hands TeamPage the team, the caller's role and the store name, and no token", async () => {
  for (const caller of ["admin", "owner"]) {
    const run = await pages.run(PAGE, { cookies: store.cookies[caller] });
    eq([run.error?.message ?? null, run.unresolved], [null, []]);
    const screen = run.props.find((p) => p.component.endsWith("#TeamPage"));
    ok(screen, `${caller}: TeamPage:`);
    eq(Object.keys(screen.props).sort(), ["initial", "role", "storeName", "supported"]);
    eq([screen.props.role, screen.props.supported, screen.props.storeName, screen.props.initial.you.role], [caller, true, a.tenant.name, caller]);
    ok(screen.props.initial.members.some((m) => m.email === CANARY), "members:");
    ok(!/token/.test(JSON.stringify(screen.props.initial.invites)), "no token in the invites:");
  }
});

console.log("— 7. the screen's markup and words");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const cache = new Map();
const resolveLocal = (id) => [`${id.slice(2)}.js`, id.slice(2)].find((c) => {
  try {
    readFileSync(join(ROOT, c));
    return true;
  } catch {
    return false;
  }
});
async function load(rel) {
  const file = join(ROOT, rel);
  if (cache.has(file)) return cache.get(file);
  const out = (await swc.transform(readFileSync(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
  const deps = new Map();
  for (const [, , id] of out.matchAll(/require\((["'])([^"']+)\1\)/g)) {
    if (deps.has(id)) continue;
    if (/^@\/(components\/(ui|kit|admin\/team)|lib)\//.test(id)) deps.set(id, await load(resolveLocal(id)));
    else if (id.startsWith("./") && rel.startsWith("lib/")) deps.set(id, await load(join(dirname(rel), id)));
    else if (id.startsWith("@/") || id.startsWith(".")) throw new Error(`${rel} imports ${id}`);
    else deps.set(id, require(id));
  }
  const mod = { exports: {} };
  new Function("require", "module", "exports", out)((id) => deps.get(id), mod, mod.exports);
  cache.set(file, mod.exports);
  return mod.exports;
}
const W = await load("components/admin/team/team-words.js");
const { TeamPage, TeamNoAccess } = await load("components/admin/team/TeamPage.js");
const { RoleSelect } = await load("components/admin/team/RoleSelect.js");
const { InviteLink } = await load("components/admin/team/InviteDialog.js");
const { TooltipProvider } = await load("components/ui/tooltip.js");
const html = (el) => renderToStaticMarkup(React.createElement(TooltipProvider, null, el));
const T = await import("../lib/admin/team.js");
const viewAs = async (caller) => T.teamView(a.id, { id: users[caller].id, role: caller });
await post("owner", { action: "invite", email: "pending-owner@team.test", role: "owner" });
await post("owner", { action: "invite", email: "pending-staff@team.test", role: "staff" });
const screen = async (caller, extra = {}) => html(React.createElement(TeamPage, { initial: await viewAs(caller), supported: true, role: caller, storeName: a.tenant.name, ...extra }));
const rowOf = (s, text) => {
  const i = s.indexOf(text);
  return i < 0 ? "" : s.slice(s.lastIndexOf("<tr", i), s.indexOf("</tr>", i));
};
await t("owner's screen: members owners first with a You marker; Change role on every row, Remove on every row but its own; Transfer and Invite; both invites revocable", async () => {
  const s = await screen("owner");
  ok(s.indexOf(users.owner.email) < s.indexOf(users.admin.email) && s.indexOf(users.admin.email) < s.indexOf(users.support.email), "owners first:");
  ok(rowOf(s, users.owner.email).includes('data-team="you"') && !rowOf(s, users.admin.email).includes('data-team="you"'), "the You marker:");
  ok(rowOf(s, users.owner.email).includes("Change role") && !rowOf(s, users.owner.email).includes('data-team="remove"'), "own row: Change role, no Remove:");
  ok(rowOf(s, users.admin.email).includes('data-team="remove"'), "others: Remove:");
  ok(s.includes('data-team="transfer"') && s.includes('data-team="invite"'), "Transfer and Invite:");
  for (const e of ["pending-owner@team.test", "pending-staff@team.test"]) ok(rowOf(s, e).includes('data-team="revoke"') && rowOf(s, e).includes("Send a new link"), `${e}:`);
  ok(s.includes("Joined") && s.includes("Expires") && s.includes("Sent"), "the columns:");
});
await t("admin's screen: no Transfer; an owner's row has no Change role or Remove; an owner invite has no Revoke or Send a new link; the staff invite has both", async () => {
  const s = await screen("admin");
  ok(!s.includes('data-team="transfer"') && s.includes('data-team="invite"'), "no Transfer:");
  const ownerRow = rowOf(s, users.owner.email);
  ok(ownerRow && !ownerRow.includes("Change role") && !ownerRow.includes("Remove"), "owner row hidden controls:");
  ok(rowOf(s, users.staff.email).includes("Change role") && rowOf(s, users.staff.email).includes("Remove"), "staff row:");
  const oi = rowOf(s, "pending-owner@team.test");
  ok(oi && !oi.includes("Revoke") && !oi.includes("Send a new link"), "owner invite:");
  ok(rowOf(s, "pending-staff@team.test").includes("Revoke"), "staff invite:");
  ok(!s.includes("data-role-gate"), "hidden, not disabled:");
});
await t("the role select offers Owner only to an owner", () => {
  const opts = (role) => [...html(React.createElement(RoleSelect, { actorRole: role, value: "staff", onChange() {} })).matchAll(/<option value="(\w+)"/g)].map((m) => m[1]);
  eq(opts("owner"), ["owner", "admin", "staff", "support"]);
  eq(opts("admin"), ["admin", "staff", "support"]);
});
await t("states: no access, not supported, a failed read with Try again (a marked read); no React warning", async () => {
  const errs = [];
  const orig = console.error;
  console.error = (...x) => errs.push(x.map(String).join(" ").slice(0, 300));
  try {
    const na = html(React.createElement(TeamNoAccess));
    ok(na.includes('data-team="no-access"') && na.includes("Only the store&#x27;s owners and admins") && !/<button/.test(na), "no access:");
    const un = html(React.createElement(TeamPage, { initial: null, supported: false, role: "owner", storeName: null }));
    ok(un.includes("platform control plane") && !un.includes('data-team="invite"'), "unsupported:");
    const er = html(React.createElement(TeamPage, { initial: null, supported: true, role: "owner", storeName: "x" }));
    ok(er.includes('role="alert"') && /<button[^>]*data-read-control[^>]*>Try again/.test(er), "error:");
    await screen("owner");
    await screen("admin");
  } finally {
    console.error = orig;
  }
  eq(errs, []);
});
await t("words: the already-a-member warning (at or above the role), the mail outcomes, dates in UTC", () => {
  const members = [{ email: "a@x.test", name: "Asha", role: "admin" }];
  ok(/already on the team as Admin/.test(W.inviteWarning(members, " A@x.test ", "staff")), "lower:");
  ok(W.inviteWarning(members, "a@x.test", "admin"), "same:");
  eq(W.inviteWarning(members, "a@x.test", "owner"), null, "a raise:");
  eq(W.inviteWarning(members, "b@x.test", "staff"), null, "someone new:");
  eq(W.mailWords({ status: "sent" }, "z@x.test").tone, "success");
  ok(/couldn't email/.test(W.mailWords({ status: "failed" }, "z@x.test").text));
  ok(/isn't set up/.test(W.mailWords({ status: "not-configured" }, "z@x.test").text));
  eq(W.dateWords("2026-11-03T23:30:00.000Z"), "3 Nov 2026");
  eq(W.refusalWords({ error: "Plain words." }), "Plain words.");
  eq(W.refusalWords(null), W.TEAM_WORDS.failed);
});
await t("the invite link view: the link, Copy, and the mail words (failed and not set up)", () => {
  const s = html(React.createElement(InviteLink, { result: { email: "n@x.test", role: "staff", inviteUrl: "/admin/accept-invite?token=abc", mail: { status: "failed" } } }));
  ok(s.includes("/admin/accept-invite?token=abc") && s.includes("Copy link") && s.includes('data-mail="failed"') && s.includes("couldn&#x27;t email"), "failed:");
  ok(html(React.createElement(InviteLink, { result: { email: "n@x.test", role: "staff", inviteUrl: "/x", mail: { status: "not-configured" } } })).includes("isn&#x27;t set up"), "not set up:");
});
await t("the screen never writes outside /api/admin/team; transfer reloads from the server", () => {
  for (const f of ["TeamPage", "MembersTable", "InvitesTable", "InviteDialog", "RoleSelect", "RemoveDialog", "TransferDialog"]) {
    const src = read(`components/admin/team/${f}.js`);
    ok(!/fetch\((?!"\/api\/admin\/team")/.test(src), `${f} fetches only the team route:`);
    ok(!/components\/(console|admin\/(?!team))/.test(src), `${f}: no old console imports:`);
  }
  ok(/window\.location\.reload\(\)/.test(read("components/admin/team/TeamPage.js")), "reload:");
});

await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
process.exit(fail ? 1 : 0);
