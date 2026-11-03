// Local harness databases only (P1-DRILLS). Reads the ports from this
// checkout's .design-data/harness.pid.json and talks to the local sqld over
// http://127.0.0.1. Never a hosted URL.
//   node scripts/drills/p1/db.mjs tenant "SELECT count(*) FROM products"
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function ports() {
  return JSON.parse(readFileSync(join(ROOT, ".design-data", "harness.pid.json"), "utf8")).ports.sqld;
}

export function db(which = "tenant") {
  const port = ports()[which];
  if (!port) throw new Error(`no local ${which} database`);
  return createClient({ url: `http://127.0.0.1:${port}` });
}

export async function sql(which, text, args = []) {
  const c = db(which);
  try {
    if (Array.isArray(text)) {
      const out = [];
      for (const t of text) out.push(await c.execute(typeof t === "string" ? { sql: t, args: [] } : t));
      return out;
    }
    return await c.execute({ sql: text, args });
  } finally {
    c.close();
  }
}

export async function rows(which, text, args = []) {
  const r = await sql(which, text, args);
  return r.rows.map((row) => Object.fromEntries(r.columns.map((k) => [k, row[k]])));
}

// Split on semicolons that are outside single quotes.
export function splitSql(text) {
  const out = [];
  let cur = "";
  let q = false;
  for (const ch of text) {
    if (ch === "'") q = !q;
    if (ch === ";" && !q) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [which, ...rest] = process.argv.slice(2);
  const c = db(which);
  for (const s of splitSql(rest.join(" "))) {
    try {
      const r = await c.execute(s);
      if (r.columns.length) {
        console.log(r.columns.join(" | "));
        for (const row of r.rows) console.log(r.columns.map((k) => row[k]).join(" | "));
      } else console.log(`ok (${r.rowsAffected} rows) ${s.slice(0, 100)}`);
    } catch (e) {
      console.log(`ERR ${e.code || ""} ${e.message} :: ${s.slice(0, 100)}`);
    }
  }
  c.close();
}
