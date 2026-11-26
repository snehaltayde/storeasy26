// Phase 9 line 4: a courier API call that reads the JSON answer. Node only.
// safeFetch (lib/plugins/egress.js) answers only { ok, status } and caps a
// reply at 4 KB (enough for an app's webhook acknowledgement, not for a
// tracking history), so this is its twin for reading: the same URL rules and
// the same guarded DNS lookup (checkUrl, guardedLookup: https, port 443, the
// manifest's hosts only, never a private address), no redirects, one overall
// timeout, at most MAX_BYTES read. Never throws:
//   courierFetch(url, { allowHosts, method, body, headers, timeoutMs })
//     → { ok, status, json, error? }
import https from "node:https";
import { checkUrl, guardedLookup } from "../plugins/egress.js";

export const MAX_BYTES = 256 * 1024;

export function courierFetch(raw, { allowHosts = [], method = "GET", body = null, headers = {}, timeoutMs = 5000, env = process.env } = {}) {
  const c = checkUrl(raw, { allowHosts, env });
  if (!c.ok) return Promise.resolve({ ok: false, status: null, json: null, error: "refused" });
  // the local test flag may hand back a plain-http URL; a courier call never goes plain
  if (c.url.protocol !== "https:") return Promise.resolve({ ok: false, status: null, json: null, error: "refused" });
  const u = c.url;
  const payload = body == null ? "" : String(body);
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const req = https.request({
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: `${u.pathname}${u.search}`,
      headers: { "user-agent": "Storeasy/1", accept: "application/json", ...headers, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
      lookup: guardedLookup,
      agent: false,
      servername: u.hostname,
    });
    const timer = setTimeout(() => {
      req.destroy();
      done({ ok: false, status: null, json: null, error: "timeout" });
    }, timeoutMs);
    req.on("response", (res) => {
      const status = Number(res.statusCode);
      const chunks = [];
      let read = 0;
      res.on("data", (chunk) => {
        read += chunk.length;
        if (read > MAX_BYTES) {
          res.destroy();
          done({ ok: false, status, json: null, error: "too_large" });
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          json = null;
        }
        done({ ok: status >= 200 && status < 300, status, json });
      });
      res.on("error", () => done({ ok: false, status, json: null, error: "read" }));
    });
    req.on("error", (e) => done({ ok: false, status: null, json: null, error: e?.code === "EGRESS_BLOCKED" ? "refused" : "connect" }));
    req.end(payload || undefined);
  });
}
