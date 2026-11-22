// A local Hrana-over-HTTP server backed by a real SQLite file, with fault injection.
// A write it "commits then drops" is really committed before the socket closes, so
// tests see the true shape of an unknown outcome. Localhost only.
import { createServer } from "node:http";

const decode = (v) => {
  if (v.type === "null") return null;
  if (v.type === "integer") return Number(v.value);
  if (v.type === "blob") return Buffer.from(v.base64, "base64");
  return v.value;
};
const encode = (v) => {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "bigint") return { type: "integer", value: String(v) };
  if (typeof v === "number") return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
  return { type: "text", value: String(v) };
};
const encodeResult = (rs) => ({
  cols: rs.columns.map((name) => ({ name })),
  rows: rs.rows.map((row) => rs.columns.map((_, i) => encode(row[i]))),
  affected_row_count: rs.rowsAffected,
  last_insert_rowid: rs.lastInsertRowid == null ? null : String(rs.lastInsertRowid),
});
const hranaError = (e) => ({ message: String(e?.message || e), code: "SQLITE_ERROR" });

export function fakeTurso(backing) {
  const state = {
    outage: false, // drop every request unexecuted
    // { match: RegExp, mode: "drop_before" | "commit_then_drop", before?, then? }: the
    // hooks are awaited, `before` ahead of running anything and `then` ahead of the drop.
    // With no mode, the request runs and answers normally once `before` is done.
    faults: [],
    received: [], // the SQL of each statement that arrived, including dropped ones
  };
  const stored = new Map();
  const sqlOf = (stmt) => stmt.sql ?? stored.get(stmt.sql_id);
  const toStmt = (stmt) => ({ sql: sqlOf(stmt), args: (stmt.args || []).map(decode) });

  async function runBatch(batch) {
    const n = batch.steps.length;
    const step_results = Array(n).fill(null);
    const step_errors = Array(n).fill(null);
    // The client frames its statements with BEGIN … COMMIT … ROLLBACK steps. The
    // backing client's own batch gives the same all-or-nothing transaction.
    const isControl = (s) => /^\s*(begin|commit|rollback)\b/i.test(sqlOf(s.stmt) || "");
    const user = batch.steps.flatMap((s, i) => (isControl(s) ? [] : [{ i, stmt: toStmt(s.stmt) }]));
    const empty = { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null };
    try {
      const results = await backing.batch(user.map((u) => u.stmt), "write");
      batch.steps.forEach((s, i) => {
        if (isControl(s) && !/rollback/i.test(sqlOf(s.stmt))) step_results[i] = empty;
      });
      user.forEach((u, k) => (step_results[u.i] = encodeResult(results[k])));
    } catch (e) {
      step_results[0] = empty; // BEGIN itself succeeded
      step_errors[user[0].i] = hranaError(e);
    }
    return { type: "batch", result: { step_results, step_errors } };
  }

  async function runOne(r) {
    if (r.type === "store_sql") {
      stored.set(r.sql_id, r.sql);
      return { type: "store_sql" };
    }
    if (r.type === "close_sql") return { type: "close_sql" };
    if (r.type === "close") return { type: "close" };
    if (r.type === "execute") return { type: "execute", result: encodeResult(await backing.execute(toStmt(r.stmt))) };
    if (r.type === "batch") return runBatch(r.batch);
    if (r.type === "sequence") {
      await backing.executeMultiple(r.sql);
      return { type: "sequence" };
    }
    throw new Error(`fake-turso: unhandled request ${r.type}`);
  }

  async function runPipeline(requests) {
    const results = [];
    for (const r of requests) {
      try {
        results.push({ type: "ok", response: await runOne(r) });
      } catch (e) {
        results.push({ type: "error", error: hranaError(e) });
      }
    }
    return results;
  }

  // One request at a time, like a single SQLite writer.
  let chain = Promise.resolve();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      chain = chain.then(async () => {
        const { requests } = JSON.parse(raw);
        const sqls = requests.flatMap((r) => {
          if (r.type === "store_sql") stored.set(r.sql_id, r.sql);
          if (r.type === "execute") return [sqlOf(r.stmt)];
          if (r.type === "batch") return r.batch.steps.map((s) => sqlOf(s.stmt));
          return r.type === "sequence" ? [r.sql] : [];
        });
        state.received.push(...sqls);
        if (state.outage) return req.socket.destroy();
        const at = state.faults.findIndex((f) => sqls.some((s) => f.match.test(s)));
        const fault = at >= 0 ? state.faults.splice(at, 1)[0] : null;
        await fault?.before?.();
        if (fault?.mode === "drop_before") {
          await fault.then?.();
          return req.socket.destroy();
        }
        const results = await runPipeline(requests);
        if (fault?.mode === "commit_then_drop") {
          await fault.then?.();
          return req.socket.destroy();
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ baton: null, base_url: null, results }));
      });
    });
  });

  return {
    state,
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }),
  };
}
