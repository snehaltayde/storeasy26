// Domain registry (Session 28 / BE12 core): unique normalized host
// registration with a DNS-TXT ownership challenge. Host RESOLUTION still reads
// tenants.domains (lib/platform/control.js resolveHost) — this module is the
// lifecycle: claim → prove → activate (write back into tenants.domains, which
// invalidates the host index), and remove → deactivate. Uniqueness is the
// table's PRIMARY KEY, platform-wide: a host registered to one tenant can
// never be claimed by another until it is removed, and a re-claim always mints
// a FRESH challenge — a reclaimed domain cannot impersonate its old store.
//
// DNS lookups are injectable (tests) and operator-asserted claims
// (preVerified: local/dev hosts that can't carry TXT records) are explicit and
// audited. The path-preserving primary-host HTTP redirect is deferred to
// MC21/W4 (needs middleware or the domains UX); `is_primary` +
// config.primary_host are recorded now so it has data to stand on.
import { platformDb, getTenant, patchTenant } from "./control.js";
import { newToken } from "./sessions.js";
import { audit } from "./audit.js";
import { refuse } from "./refuse.js";

export const normalizeHost = (host) => {
  const h = String(host || "").trim().toLowerCase();
  if (!h || /[\s/\\@]/.test(h)) throw refuse(400, "invalid host");
  return h;
};
const bare = (host) => host.split(":")[0];

async function getRow(host) {
  const res = await platformDb().execute({ sql: "SELECT * FROM domains WHERE host = ?", args: [host] });
  return res.rows[0] ? { ...res.rows[0] } : null;
}

// fresh reads (P1-FIX-C): the new list is built from this read, so a cached
// copy would drop a domain another instance added in the last 30 seconds.
async function activate(host, tenantId) {
  const tenant = await getTenant(tenantId, { fresh: true });
  if (!tenant) throw refuse(400, `tenant "${tenantId}" not found`);
  const domains = [...new Set([...(tenant.domains || []), host])];
  await patchTenant(tenantId, { domains }); // invalidates the host index
}

async function deactivate(host, tenantId) {
  const tenant = await getTenant(tenantId, { fresh: true });
  if (!tenant) return;
  await patchTenant(tenantId, { domains: (tenant.domains || []).filter((d) => String(d).toLowerCase() !== host) });
}

// Claim a host for a tenant. Returns { host, challenge, txtRecord } (or the
// already-active row). preVerified = operator asserts control (dev hosts):
// verified + activated immediately, method "operator".
export async function claimDomain({ host: rawHost, tenantId, preVerified = false, actor = { kind: "cli", id: "cli" } }) {
  const host = normalizeHost(rawHost);
  if (!(await getTenant(tenantId))) throw refuse(400, `tenant "${tenantId}" not found`);
  const existing = await getRow(host);
  if (existing && existing.tenant_id !== tenantId) {
    throw refuse(409, `host "${host}" is registered to tenant "${existing.tenant_id}" — remove it there first`);
  }
  const now = new Date().toISOString();
  if (existing) {
    if (existing.verified_at) return { host, verified: true, challenge: null };
    // unverified re-claim by the same tenant: keep the pending challenge
    return {
      host,
      verified: false,
      challenge: existing.challenge,
      txtRecord: { name: `_storeasy-challenge.${bare(host)}`, value: existing.challenge },
    };
  }
  const challenge = `storeasy-verify=${newToken().slice(0, 32)}`;
  await platformDb().execute({
    sql: `INSERT INTO domains (host, tenant_id, challenge, method, is_primary, verified_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
    args: [host, tenantId, challenge, preVerified ? "operator" : "dns-txt", preVerified ? now : null, now, now],
  });
  await audit({ actor, action: "domain.claimed", tenantId, resource: `domain:${host}`, diff: { preVerified } });
  if (preVerified) {
    await activate(host, tenantId);
    await audit({ actor, action: "domain.verified", tenantId, resource: `domain:${host}`, diff: { method: "operator" } });
    return { host, verified: true, challenge: null };
  }
  return {
    host,
    verified: false,
    challenge,
    txtRecord: { name: `_storeasy-challenge.${bare(host)}`, value: challenge },
  };
}

async function dnsLookupTxt(name) {
  const { resolveTxt } = await import("node:dns/promises");
  const records = await resolveTxt(name);
  return records.map((chunks) => chunks.join(""));
}

// Prove ownership via the TXT record, then activate. lookupTxt is injectable.
export async function verifyDomain({ host: rawHost, lookupTxt = dnsLookupTxt, actor = { kind: "cli", id: "cli" } }) {
  const host = normalizeHost(rawHost);
  const row = await getRow(host);
  if (!row) return { ok: false, error: "host is not claimed" };
  if (row.verified_at) return { ok: true, already: true };
  const name = `_storeasy-challenge.${bare(host)}`;
  let records = [];
  try {
    records = await lookupTxt(name);
  } catch (e) {
    return { ok: false, error: `TXT lookup failed for ${name}: ${String(e?.message || e).slice(0, 120)}` };
  }
  if (!records.includes(row.challenge)) {
    return { ok: false, error: `TXT record at ${name} does not contain the challenge value yet` };
  }
  await platformDb().execute({
    sql: "UPDATE domains SET verified_at = ?, method = 'dns-txt', updated_at = ? WHERE host = ?",
    args: [new Date().toISOString(), new Date().toISOString(), host],
  });
  await activate(host, row.tenant_id);
  await audit({ actor, action: "domain.verified", tenantId: row.tenant_id, resource: `domain:${host}`, diff: { method: "dns-txt" } });
  return { ok: true };
}

// Remove = deregister + deactivate. A later claim (any tenant) starts from a
// fresh challenge — prior verification never carries over.
export async function removeDomain({ host: rawHost, actor = { kind: "cli", id: "cli" } }) {
  const host = normalizeHost(rawHost);
  const row = await getRow(host);
  if (!row) return false;
  await platformDb().execute({ sql: "DELETE FROM domains WHERE host = ?", args: [host] });
  await deactivate(host, row.tenant_id);
  await audit({ actor, action: "domain.removed", tenantId: row.tenant_id, resource: `domain:${host}` });
  return true;
}

// Mark the tenant's primary host (one per tenant) + mirror into
// config.primary_host for canonical URLs; the HTTP redirect lands with MC21.
export async function setPrimaryDomain({ host: rawHost, actor = { kind: "cli", id: "cli" } }) {
  const host = normalizeHost(rawHost);
  const row = await getRow(host);
  if (!row) throw refuse(400, "host is not claimed");
  if (!row.verified_at) throw refuse(400, "verify the host before making it primary");
  await platformDb().execute({ sql: "UPDATE domains SET is_primary = 0 WHERE tenant_id = ?", args: [row.tenant_id] });
  await platformDb().execute({ sql: "UPDATE domains SET is_primary = 1, updated_at = ? WHERE host = ?", args: [new Date().toISOString(), host] });
  await patchTenant(row.tenant_id, { config: { primary_host: host } });
  await audit({ actor, action: "domain.primary", tenantId: row.tenant_id, resource: `domain:${host}` });
  return true;
}

export async function listDomains({ tenantId = null } = {}) {
  const res = tenantId
    ? await platformDb().execute({ sql: "SELECT * FROM domains WHERE tenant_id = ? ORDER BY host", args: [tenantId] })
    : await platformDb().execute("SELECT * FROM domains ORDER BY tenant_id, host");
  return res.rows.map((r) => ({ ...r }));
}
