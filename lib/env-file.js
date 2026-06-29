import { readFile, writeFile } from "node:fs/promises";

// Upsert KEY=value lines into an env file (default .env.local), preserving the rest.
export async function upsertEnv(updates, file = ".env.local") {
  let env = "";
  try {
    env = await readFile(file, "utf8");
  } catch {
    /* file may not exist yet */
  }
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(env)) {
      env = env.replace(re, line);
    } else {
      env += (env === "" || env.endsWith("\n") ? "" : "\n") + line + "\n";
    }
  }
  await writeFile(file, env);
}
