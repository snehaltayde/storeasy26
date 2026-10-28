// Design-preview dev server (S50): spawns `next dev -p 3017` against the
// LOCAL file DBs the seed script builds. Test credentials are generated
// once into .design-env (gitignored) — local-only values for reviewing the
// console redesign; they touch nothing hosted.
//   pnpm seed:design   (first, and whenever you want fresh data)
//   pnpm dev:design
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".design-env");

if (!existsSync(envFile)) {
  writeFileSync(
    envFile,
    [
      `DESIGN_ADMIN_PASSWORD=design-${randomBytes(6).toString("hex")}`,
      `PLATFORM_ADMIN_PASSWORD=operator-${randomBytes(6).toString("hex")}`,
      "",
    ].join("\n"),
    { mode: 0o600 }
  );
  console.log("• generated local test credentials → .design-env (gitignored)");
}
const fileEnv = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
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
  PORT: "3017",
};

const cmd = process.argv[2] === "seed" ? ["node", ["scripts/seed-design-preview.js"]] : ["pnpm", ["exec", "next", "dev", "-p", "3017"]];
const child = spawn(cmd[0], cmd[1], { cwd: root, env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
