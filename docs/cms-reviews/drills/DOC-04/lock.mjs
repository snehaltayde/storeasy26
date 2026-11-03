// Hold an exclusive lock on a local SQLite file for N seconds, so the app's
// next write meets a database that can't answer (SQLITE_BUSY). Drill D7 only,
// against the LOCAL harness file; never point it at anything hosted.
//   node lock.mjs <dbfile> <seconds>
import { createRequire } from "node:module";
const [file, seconds] = process.argv.slice(2);
const require = createRequire(`${process.cwd()}/package.json`);
const { createClient } = await import(require.resolve("@libsql/client"));
const c = createClient({ url: `file:${file}` });
await c.execute("BEGIN EXCLUSIVE");
console.log("locked", file, "pid", process.pid);
setTimeout(async () => {
  await c.execute("ROLLBACK");
  console.log("released");
  process.exit(0);
}, Number(seconds) * 1000);
