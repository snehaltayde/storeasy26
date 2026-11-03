// PERF-04: a counting proxy between Next and one local sqld.
//
// Every database call the app makes reaches sqld as an HTTP request in the
// Hrana protocol (@libsql/client over http speaks Hrana v2, JSON). This proxy
// forwards each request byte for byte and counts what went by: round trips,
// statements (read, write, schema, transaction control), the rows sqld says
// it read, the rows it sent back, and the bytes moved. The app is not changed
// and doesn't know the proxy is there; the counts come from the wire.
//
// A request this proxy can't read (another protocol version, protobuf) is
// still forwarded and counted as a round trip, and `unparsed` goes up, so a
// count can never silently come out low.
import http from "node:http";
import zlib from "node:zlib";

export const KINDS = ["read", "write", "schema", "tx", "other"];

// What a statement does, from its first keyword.
export function classify(sql) {
  const text = String(sql || "")
    .replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, "")
    .trimStart();
  const word = (text.match(/^[A-Za-z]+/) || [""])[0].toUpperCase();
  if (["SELECT", "WITH", "PRAGMA", "EXPLAIN", "VALUES"].includes(word)) return "read";
  if (["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(word)) return "write";
  if (["CREATE", "ALTER", "DROP", "REINDEX", "VACUUM", "ANALYZE"].includes(word)) return "schema";
  if (["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"].includes(word)) return "tx";
  return "other";
}

// One line per statement shape: literals out, whitespace squeezed.
export function shape(sql) {
  return String(sql || "")
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\b\d+(\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function emptyCounts() {
  return { roundTrips: 0, otherRequests: 0, unparsed: 0, statements: Object.fromEntries(KINDS.map((k) => [k, 0])), rowsRead: 0, rowsWritten: 0, rowsReturned: 0, queryMs: 0, bytesUp: 0, bytesDown: 0, bytesDownDecoded: 0, errors: 0, shapes: {}, shapeRows: {}, shapeBytes: {}, exact: {} };
}

// Read one Hrana v2/v3 JSON pipeline (or cursor) request and its response,
// and add what they did to `counts`.
export function countExchange(counts, { path, reqBody, resBody, status, encoding = null }) {
  counts.bytesUp += reqBody.length;
  counts.bytesDown += resBody.length; // as sent, compressed if sqld compressed it
  if (encoding) {
    try {
      resBody = encoding === "gzip" ? zlib.gunzipSync(resBody) : encoding === "br" ? zlib.brotliDecompressSync(resBody) : encoding === "deflate" ? zlib.inflateSync(resBody) : resBody;
    } catch {
      counts.unparsed++;
      return;
    }
  }
  counts.bytesDownDecoded += resBody.length; // what the app had to parse
  if (!/\/pipeline$|\/cursor$/.test(path)) {
    counts.otherRequests++;
    return;
  }
  counts.roundTrips++;
  let req;
  try {
    req = JSON.parse(reqBody.toString("utf8"));
  } catch {
    counts.unparsed++;
    return;
  }
  const stored = new Map(); // sql_id → sql, from store_sql in the same request
  const stmtOf = (stmt) => ({ sql: stmt?.sql != null ? stmt.sql : stored.get(stmt?.sql_id) ?? null, args: [stmt?.args ?? [], stmt?.named_args ?? []] });
  const requests = Array.isArray(req.requests) ? req.requests : req.batch ? [{ type: "batch", batch: req.batch }] : [];
  // One entry per request entry, so the response's results line up by index.
  const units = requests.map((r) => {
    if (r?.type === "store_sql") {
      stored.set(r.sql_id, r.sql);
      return null;
    }
    if (r?.type === "execute") return [stmtOf(r.stmt)];
    if (r?.type === "batch") return (r.batch?.steps || []).map((step) => stmtOf(step?.stmt));
    if (r?.type === "sequence") return [{ sql: r.sql ?? stored.get(r.sql_id) ?? null, args: null }];
    return null;
  });
  const countStmt = ({ sql, args }, res = null) => {
    const kind = sql == null ? "other" : classify(sql);
    counts.statements[kind]++;
    if (kind === "read" || kind === "write") {
      const key = `${kind.toUpperCase()} ${shape(sql)}`;
      counts.shapes[key] = (counts.shapes[key] || 0) + 1;
      counts.shapeRows[key] = (counts.shapeRows[key] || 0) + (Number(res?.rows_read) || 0);
      // P2-PERF: the bytes of this statement's own result in the answer (its
      // columns and rows as JSON), so a route's parsed bytes can be split by statement
      counts.shapeBytes[key] = (counts.shapeBytes[key] || 0) + (res ? Buffer.byteLength(JSON.stringify(res)) : 0);
      // the same statement with the same arguments: a true repeat
      const exactKey = `${key}\u0000${JSON.stringify(args)}`;
      counts.exact[exactKey] = (counts.exact[exactKey] || 0) + 1;
    }
  };
  const countAll = () => units.forEach((u) => u?.forEach(countStmt));
  if (status >= 400) counts.errors++;
  // sqld's own figures for each statement it ran
  const addResult = (res) => {
    if (!res || typeof res !== "object") return;
    counts.rowsRead += Number(res.rows_read) || 0;
    counts.rowsWritten += Number(res.rows_written) || 0;
    counts.queryMs += Number(res.query_duration_ms) || 0;
    if (Array.isArray(res.rows)) counts.rowsReturned += res.rows.length;
  };
  let resJson = null;
  try {
    resJson = JSON.parse(resBody.toString("utf8"));
  } catch {
    // a cursor answers with one JSON object per line
    countAll();
    try {
      for (const line of resBody.toString("utf8").split("\n").filter(Boolean)) {
        const entry = JSON.parse(line);
        if (entry?.type === "row") counts.rowsReturned++;
        if (entry?.type === "step_end") addResult(entry);
        if (entry?.type === "error" || entry?.type === "step_error") counts.errors++;
      }
    } catch {
      counts.unparsed++;
    }
    return;
  }
  if (!Array.isArray(resJson?.results)) {
    countAll();
    if (status < 400) counts.unparsed++;
    return;
  }
  // Count what sqld ran: a batch step skipped by its condition (the ROLLBACK
  // after a COMMIT that worked) has neither a result nor an error.
  resJson.results.forEach((result, i) => {
    const unit = units[i];
    if (result?.type === "error") {
      counts.errors++;
      unit?.forEach(countStmt);
      return;
    }
    const resp = result?.response;
    if (resp?.type === "execute") {
      unit?.forEach((stmt) => countStmt(stmt, resp.result));
      addResult(resp.result);
    } else if (resp?.type === "batch") {
      const results = resp.result?.step_results || [];
      const errors = resp.result?.step_errors || [];
      unit?.forEach((stmt, j) => {
        if (results[j] != null || errors[j] != null) countStmt(stmt, results[j]);
        if (results[j] != null) addResult(results[j]);
        if (errors[j] != null) counts.errors++;
      });
    } else if (resp?.type === "sequence") unit?.forEach(countStmt);
  });
}

// Reads that ran again, with the same arguments, in the same request.
export function repeatedReads(counts) {
  return Object.entries(counts.exact)
    .filter(([k, n]) => n > 1 && k.startsWith("READ "))
    .map(([k, n]) => ({ times: n, shape: k.split("\u0000")[0].slice(5) }))
    .sort((a, b) => b.times - a.times);
}

export function addCounts(into, from) {
  for (const k of ["roundTrips", "otherRequests", "unparsed", "rowsRead", "rowsWritten", "rowsReturned", "queryMs", "bytesUp", "bytesDown", "bytesDownDecoded", "errors"]) into[k] += from[k];
  for (const k of KINDS) into.statements[k] += from.statements[k];
  for (const [s, n] of Object.entries(from.shapes)) into.shapes[s] = (into.shapes[s] || 0) + n;
  for (const [s, n] of Object.entries(from.shapeRows)) into.shapeRows[s] = (into.shapeRows[s] || 0) + n;
  for (const [s, n] of Object.entries(from.shapeBytes || {})) into.shapeBytes[s] = (into.shapeBytes[s] || 0) + n;
  for (const [s, n] of Object.entries(from.exact)) into.exact[s] = (into.exact[s] || 0) + n;
  return into;
}

// A proxy on 127.0.0.1:listenPort in front of sqld on 127.0.0.1:upstreamPort.
// take() returns the counts since the last take() and starts again from zero.
export function startCountingProxy({ listenPort, upstreamPort, upstreamHost = "127.0.0.1" }) {
  let counts = emptyCounts();
  let inFlight = 0;
  let lastActivity = 0;
  const server = http.createServer((req, res) => {
    inFlight++;
    lastActivity = performance.now();
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const reqBody = Buffer.concat(chunks);
      const headers = { ...req.headers, host: `${upstreamHost}:${upstreamPort}` };
      const up = http.request({ host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers }, (upRes) => {
        const out = [];
        upRes.on("data", (c) => out.push(c));
        upRes.on("end", () => {
          const resBody = Buffer.concat(out);
          try {
            countExchange(counts, { path: req.url.split("?")[0], reqBody, resBody, status: upRes.statusCode, encoding: upRes.headers["content-encoding"] || null });
          } catch {
            counts.unparsed++;
          }
          res.writeHead(upRes.statusCode, upRes.headers);
          res.end(resBody);
          inFlight--;
          lastActivity = performance.now();
        });
      });
      up.on("error", (e) => {
        counts.errors++;
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`counting proxy: upstream failed: ${e.message}`);
        inFlight--;
        lastActivity = performance.now();
      });
      up.end(reqBody);
    });
  });
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve());
  });
  return {
    ready,
    url: `http://127.0.0.1:${listenPort}`,
    take() {
      const c = counts;
      counts = emptyCounts();
      return c;
    },
    // Resolves once nothing has gone through for quietMs (or after maxMs).
    async settle({ quietMs = 120, maxMs = 3000 } = {}) {
      const start = performance.now();
      while (performance.now() - start < maxMs) {
        if (inFlight === 0 && performance.now() - lastActivity >= quietMs) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// sqld's own counters (its admin API, /v1/namespaces/default/stats), used to
// check the proxy's statement count against the server's.
export async function sqldQueryCount(adminPort) {
  const r = await fetch(`http://127.0.0.1:${adminPort}/v1/namespaces/default/stats`);
  if (!r.ok) throw new Error(`sqld stats answered ${r.status}`);
  const s = await r.json();
  return { queries: Number(s.query_count) || 0, rowsRead: Number(s.rows_read_count) || 0 };
}
