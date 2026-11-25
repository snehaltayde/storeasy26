// Phase 4 line 3: the egress guard. Every request a plugin makes through
// Storeasy (a custom app's webhook, a first-party plugin's outbound call)
// goes through safeFetch(). NODE-ONLY: only the worker's delivery path
// (lib/plugins/deliveries.js, loaded by lib/platform/worker.js with a dynamic
// import) and the endpoint save check may import it; test:plugin-webhooks
// proves no storefront page or components/ file can reach it.
//
// Rules (docs/plans/phase-4.md "Outbox delivery: egress guard"):
//   URL      https: on port 443 only; no user:password@; the host is a DNS
//            name, never an IP literal, and passes hostProblem() (no
//            localhost / *.local / *.internal / *.home.arpa, never Shopify);
//            the host must be on the caller's allowlist (a custom app: the one
//            host approved when its endpoint was saved; a first-party plugin:
//            its manifest's egress list)
//   DNS      guardedLookup() resolves every address (all: true, whatever the
//            caller asked for) and refuses the connection if ANY of them is in
//            BLOCKED (private, loopback, link-local, carrier NAT, test,
//            multicast and reserved ranges, v4 and v6, NAT64, Teredo and
//            site-local included); an IPv6 address that carries an IPv4 one
//            (mapped, SIIT, compatible, 6to4) is also checked as that IPv4. The
//            check runs at connect time, so a rebinding name can't swap in a
//            private address after a check.
//   HTTP     node:https.request with agent: false (a fresh, checked connection
//            each time); redirects are never followed (a 3xx is a failed
//            attempt); at most 4 KB of the response is read and dropped; a
//            5 s to connect and 10 s in all (a trickled answer too); only a
//            short error string comes back.
//   Tests    STOREASY_PLUGIN_EGRESS_LOCAL=1 lets http(s)://127.0.0.1:<port>
//            through, and only that host, and only when NODE_ENV is "test" or
//            "development" and no VERCEL_ENV / VERCEL is set. Anywhere else
//            the flag is ignored (fail closed), so the loopback address is
//            refused as an IP literal like any other.
import https from "node:https";
import http from "node:http";
import dns from "node:dns";
import net from "node:net";
import { hostProblem, normalHost } from "./hosts.js";

export const BLOCKED_V4 = Object.freeze([
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]);
export const BLOCKED_V6 = Object.freeze([
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["64:ff9b::", 96],
  // review additions: NAT64 local use, Teredo, discard-only, site-local, IPv4-compatible
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["100::", 64],
  ["fec0::", 10],
  ["::", 96],
]);
const BLOCK = new net.BlockList();
for (const [a, p] of BLOCKED_V4) BLOCK.addSubnet(a, p, "ipv4");
for (const [a, p] of BLOCKED_V6) BLOCK.addSubnet(a, p, "ipv6");

export const TIMEOUT_MS = 10_000;
export const CONNECT_TIMEOUT_MS = 5_000;
export const MAX_RESPONSE_BYTES = 4096;
export const LOCAL_FLAG = "STOREASY_PLUGIN_EGRESS_LOCAL";
const LOOPBACK = "127.0.0.1";

// an IPv6 address as its eight 16-bit groups (a dotted IPv4 tail and a zone
// accepted), or null
function groupsOf(address) {
  let s = String(address).toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let tail = [];
  const dotted = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const p = dotted[2].split(".").map(Number);
    if (p.some((x) => x > 255)) return null;
    tail = [((p[0] << 8) | p[1]).toString(16), ((p[2] << 8) | p[3]).toString(16)];
    s = dotted[1].endsWith("::") ? dotted[1] : dotted[1].slice(0, -1);
  }
  const [head, rest] = s.includes("::") ? s.split("::") : [s, null];
  const h = head ? head.split(":").filter((x) => x !== "") : [];
  const r = rest ? rest.split(":").filter((x) => x !== "") : [];
  const fill = rest === null ? 0 : 8 - h.length - r.length - tail.length;
  if (fill < 0) return null;
  const groups = [...h, ...Array(fill).fill("0"), ...r, ...tail].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => !(g >= 0 && g <= 0xffff))) return null;
  return groups;
}
const v4of = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");

// The IPv4 addresses an IPv6 address carries, to check against the v4 list:
// IPv4-mapped ::ffff:a.b.c.d, SIIT ::ffff:0:a.b.c.d, IPv4-compatible
// ::a.b.c.d (also blocked whole, ::/96) and 6to4 2002:AABB:CCDD::/48.
function embeddedV4(address) {
  const g = groupsOf(address);
  if (!g) return [];
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
  const out = [];
  if (zero(0, 5) && g[5] === 0xffff) out.push(v4of(g[6], g[7]));
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) out.push(v4of(g[6], g[7]));
  if (zero(0, 6)) out.push(v4of(g[6], g[7]));
  if (g[0] === 0x2002) out.push(v4of(g[1], g[2]));
  return out;
}

// true when the connection must not be made. Anything that isn't an IP
// address at all is refused too (fail closed).
export function isBlockedAddress(address) {
  const bare = String(address ?? "").split("%")[0];
  const fam = net.isIP(bare);
  if (fam === 4) return BLOCK.check(bare, "ipv4");
  if (fam === 6) return BLOCK.check(bare, "ipv6") || embeddedV4(bare).some((v4) => BLOCK.check(v4, "ipv4"));
  return true;
}

// Only a test or development server, never a Vercel deployment of any kind.
export function localEgressAllowed(env = process.env) {
  if (env[LOCAL_FLAG] !== "1") return false;
  if (env.VERCEL_ENV || env.VERCEL) return false;
  return env.NODE_ENV === "test" || env.NODE_ENV === "development";
}

// → { ok: true, url, host, local } or { ok: false, reason } (plain words).
// allowHosts null skips the allowlist (the save-time check of a new address).
export function checkUrl(raw, { allowHosts = [], env = process.env } = {}) {
  let u;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    return { ok: false, reason: "That isn't a web address. Use one like https://example.com/webhooks." };
  }
  const local = localEgressAllowed(env) && u.hostname === LOOPBACK && (u.protocol === "http:" || u.protocol === "https:");
  if (u.username || u.password) return { ok: false, reason: "Leave the user name and password out of the address." };
  if (!local) {
    if (u.protocol !== "https:") return { ok: false, reason: "The address must start with https://." };
    if (u.port !== "") return { ok: false, reason: "The address must use the standard HTTPS port (443)." };
    const problem = hostProblem(u.hostname);
    if (problem) return { ok: false, reason: problem };
  }
  const host = local ? LOOPBACK : normalHost(u.hostname);
  if (allowHosts !== null && !(Array.isArray(allowHosts) && allowHosts.map(normalHost).includes(host))) {
    return { ok: false, reason: "That address isn't on this app's approved list." };
  }
  return { ok: true, url: u, host, local };
}

// a seam for the suite (it answers lookups with chosen addresses)
export const egressDns = { lookup: dns.lookup };

const blockedError = () => Object.assign(new Error("The address resolves to a private or reserved network."), { code: "EGRESS_BLOCKED" });

// dns.lookup's signature, as net.connect calls it (options may be a family
// number; Node's autoSelectFamily default asks for all: true).
export function guardedLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const opts = typeof options === "number" ? { family: options } : { ...(options || {}) };
  egressDns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(String(addresses)) }]).filter((a) => a && a.address);
    if (!list.length) return callback(Object.assign(new Error("No address found."), { code: "ENOTFOUND" }));
    if (list.some((a) => isBlockedAddress(a.address))) return callback(blockedError());
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family || net.isIP(list[0].address));
  });
}

const lookupAll = (host) => new Promise((resolve, reject) => guardedLookup(host, { all: true }, (e, list) => (e ? reject(e) : resolve(list))));

// The save-time check: the same URL rules plus a DNS resolve through the
// guard. Send time is the real gate (an address can change after saving).
// → { ok: true, url, host } or { ok: false, reason }
export async function checkEndpointUrl(raw, { env = process.env } = {}) {
  const c = checkUrl(raw, { allowHosts: null, env });
  if (!c.ok) return c;
  if (c.local) return { ok: true, url: c.url.href, host: c.host };
  try {
    await lookupAll(c.host);
  } catch (e) {
    if (e?.code === "EGRESS_BLOCKED") return { ok: false, reason: "That address points to a private network. Use a public HTTPS address." };
    return { ok: false, reason: "We couldn't find that address. Check the host name." };
  }
  return { ok: true, url: c.url.href, host: c.host };
}

const shortError = (e) => {
  if (e?.code === "EGRESS_BLOCKED") return "Refused: the address resolves to a private network";
  if (e?.code === "TIMEOUT") return "No answer in time";
  if (e?.code === "ENOTFOUND") return "The host name wasn't found";
  if (e?.code === "ECONNREFUSED") return "The connection was refused";
  if (e?.code) return `Couldn't connect (${String(e.code).slice(0, 40)})`;
  return "Couldn't connect";
};

// → { ok, status, ms, error?, refused? }. Never throws: every failure is a
// failed attempt the caller schedules.
export function safeFetch(raw, { allowHosts = [], method = "POST", body = "", headers = {}, timeoutMs = TIMEOUT_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS, env = process.env } = {}) {
  const c = checkUrl(raw, { allowHosts, env });
  if (!c.ok) return Promise.resolve({ ok: false, refused: true, status: null, ms: 0, error: `Refused: ${c.reason}` });
  const u = c.url;
  const plain = c.local && u.protocol === "http:";
  const payload = body == null ? "" : String(body);
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ms: Date.now() - started, ...r });
    };
    const req = (plain ? http : https).request({
      method,
      hostname: u.hostname,
      port: u.port || (plain ? 80 : 443),
      path: `${u.pathname}${u.search}`,
      headers: { "user-agent": "Storeasy-Webhooks/1", ...headers, "content-length": Buffer.byteLength(payload) },
      lookup: guardedLookup,
      agent: false,
      servername: plain ? undefined : u.hostname,
    });
    const timeout = () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" }));
    // the whole exchange (a trickled answer included) and, inside it, the connection
    const timer = setTimeout(timeout, timeoutMs);
    req.on("socket", (sock) => {
      if (!sock.connecting) return;
      const c = setTimeout(timeout, connectTimeoutMs);
      const clear = () => clearTimeout(c);
      sock.once(plain ? "connect" : "secureConnect", clear);
      sock.once("close", clear);
    });
    req.on("response", (res) => {
      let read = 0;
      const status = Number(res.statusCode);
      res.on("data", (chunk) => {
        read += chunk.length;
        if (read >= MAX_RESPONSE_BYTES) res.destroy();
      });
      const finish = () => done({ ok: status >= 200 && status < 300, status, ...(status >= 300 && status < 400 ? { error: "Redirects aren't followed" } : {}) });
      res.on("end", finish);
      res.on("close", finish);
      res.on("error", finish);
    });
    req.on("error", (e) => done({ ok: false, status: null, refused: e?.code === "EGRESS_BLOCKED", error: shortError(e) }));
    req.end(payload);
  });
}
