// P2-ATOM: a byte-forwarding Hrana HTTP proxy that injects transport faults.
// Test support only. Modelled on scripts/perf-dbcount.js (startCountingProxy).
//
// @libsql/client over http sends every statement, batch included, as one
// POST to /v2/pipeline or /v3/pipeline. This proxy sits between the client and
// one local sqld and can fail those requests on purpose:
//
//   pass()                     forward everything (the default)
//   dropBefore(n, match)       for the next n matching pipeline requests, destroy
//                              the client socket WITHOUT forwarding: the server
//                              never sees the request
//   commitThenDrop(n, match)   for the next n matching pipeline requests, forward,
//                              wait for sqld's full answer (so the batch has
//                              committed), then destroy the client socket before
//                              writing a single response byte. The client sees
//                              "fetch failed", which HEAD lib/db.js isTransient()
//                              retries, although the write already happened
//   hold(match)                queue matching pipeline requests until release()
//                              forwards them, for ordering two requests
//
// n may be Infinity. `match` is "batch" (a pipeline that carries a batch: the
// publish commit) or "any" (every pipeline request, reads included).
//
// Only pipeline requests are counted or faulted. The version probe (GET /v2,
// /v3) and any other path always pass, so a fault can't land on the probe.
import http from "node:http";

const PIPELINE = /^\/v[23]\/pipeline$/;

function parse(body) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}
const hasBatch = (req) => Array.isArray(req?.requests) && req.requests.some((r) => r?.type === "batch");

export function emptyCounters() {
  return { pipelines: 0, batches: 0, executes: 0, other: 0, dropped: 0, committedThenDropped: 0, held: 0, forwarded: 0, upstreamErrors: 0 };
}

export function startFaultProxy({ listenPort, upstreamPort, upstreamHost = "127.0.0.1" }) {
  let counters = emptyCounters();
  let rule = { mode: "pass" };
  const heldQueue = [];
  const sockets = new Set();

  const forward = (req, reqBody, onAnswer) => {
    const headers = { ...req.headers, host: `${upstreamHost}:${upstreamPort}` };
    const up = http.request({ host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers }, (upRes) => {
      const out = [];
      upRes.on("data", (c) => out.push(c));
      upRes.on("end", () => onAnswer(null, upRes, Buffer.concat(out)));
    });
    up.on("error", (e) => onAnswer(e));
    up.end(reqBody);
  };

  const reply = (res) => (err, upRes, body) => {
    if (err) {
      counters.upstreamErrors++;
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`fault proxy: upstream failed: ${err.message}`);
      return;
    }
    counters.forwarded++;
    res.writeHead(upRes.statusCode, upRes.headers);
    res.end(body);
  };

  const matches = (m, isBatch) => m === "any" || (m === "batch" && isBatch);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const reqBody = Buffer.concat(chunks);
      const path = req.url.split("?")[0];
      if (!PIPELINE.test(path)) {
        counters.other++;
        forward(req, reqBody, reply(res));
        return;
      }
      const parsed = parse(reqBody);
      const isBatch = hasBatch(parsed);
      counters.pipelines++;
      if (isBatch) counters.batches++;
      else counters.executes++;

      const r = rule;
      if (r.mode === "drop_before" && r.left > 0 && matches(r.match, isBatch)) {
        r.left--;
        counters.dropped++;
        req.socket.destroy();
        return;
      }
      if (r.mode === "commit_then_drop" && r.left > 0 && matches(r.match, isBatch)) {
        r.left--;
        forward(req, reqBody, () => {
          // sqld has answered, so the batch ran. The client gets nothing.
          counters.committedThenDropped++;
          req.socket.destroy();
        });
        return;
      }
      if (r.mode === "hold" && matches(r.match, isBatch)) {
        counters.held++;
        heldQueue.push({ body: reqBody, text: reqBody.toString("utf8"), go: () => forward(req, reqBody, reply(res)) });
        return;
      }
      forward(req, reqBody, reply(res));
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  // listenPort 0 asks the system for a free port; `url` is right once `ready`.
  let port = listenPort;
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => {
      port = server.address().port;
      resolve();
    });
  });

  return {
    ready,
    get port() {
      return port;
    },
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    get counters() {
      return { ...counters };
    },
    resetCounters() {
      counters = emptyCounters();
    },
    pass() {
      rule = { mode: "pass" };
    },
    dropBefore(n = 1, match = "batch") {
      rule = { mode: "drop_before", left: n, match };
    },
    commitThenDrop(n = 1, match = "batch") {
      rule = { mode: "commit_then_drop", left: n, match };
    },
    hold(match = "batch") {
      rule = { mode: "hold", match };
    },
    heldCount: () => heldQueue.length,
    // Forward the held request whose body contains `needle` (or the oldest).
    release(needle = null) {
      const i = needle == null ? 0 : heldQueue.findIndex((h) => h.text.includes(needle));
      if (i < 0) throw new Error(`fault proxy: no held request contains ${needle}`);
      const [h] = heldQueue.splice(i, 1);
      h.go();
    },
    async waitHeld(n, timeoutMs = 5000) {
      const start = Date.now();
      while (heldQueue.length < n) {
        if (Date.now() - start > timeoutMs) throw new Error(`fault proxy: only ${heldQueue.length} of ${n} requests arrived`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close() {
      for (const h of heldQueue.splice(0)) h.go();
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}
