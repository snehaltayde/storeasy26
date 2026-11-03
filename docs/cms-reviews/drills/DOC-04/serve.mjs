// The design harness's dev server (scripts/dev-design.js), on a private port.
// Same env as that script; only the port differs (3017 is the shared one).
//   node serve.mjs <worktree> <port>
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [root, port] = process.argv.slice(2);
const fileEnv = Object.fromEntries(
  readFileSync(join(root, ".design-env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const env = {
  ...process.env,
  ...fileEnv,
  TURSO_DB_URL: "",
  RESEND_API_KEY: "",
  DATABASE_URL: "file:.design-default.db",
  PLATFORM_DB_URL: "file:.design-platform.db",
  PLATFORM_DB_TOKEN: "",
  PLATFORM_SECRET: "design-preview-secret",
  PORT: port,
};
const child = spawn("pnpm", ["exec", "next", "dev", "-p", port], { cwd: root, env, stdio: "inherit" });
console.log("next pid", child.pid);
child.on("exit", (code) => process.exit(code ?? 0));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
