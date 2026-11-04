// P3-SCAFFOLD: checks lib/admin/documents-api-shapes.js, the phase 3 response
// contract of the documents console API, against the code that answers today.
//   pnpm test:api-shapes
//
// 1. The file is data only: no import, require, dynamic import, node: API or
//    function, so the edge storefront and the console client can both load it.
// 2. Every operation and outcome is well formed: a status, since p2|p3, a body
//    with error and code on every refusal that has a code, ok on every 200, and
//    every optional and addedInPhase3 path names a key the example really has.
// 3. Every outcome the API gives today ("p2") uses a code string that
//    lib/admin/documents-api.js, lib/documents/*.js or lib/cms/issues.js emits
//    today, with the same status wherever the source pairs them; a "p3"
//    outcome's code is either one of those or one of the new codes listed here.
// 4. The fields of today's outcomes match the code: the issue keys, the
//    validation and failure() bodies and words, the document, list and history
//    rows, the publish result, the legacy and 428 words, and the requests of
//    today's operations parse with today's parser.
// No database is opened: the parser and lib/cms/issues.js are pure.
import { readFile, readdir } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
// documents-api.js pulls in lib/db.js; nothing here ever queries it.
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-api-shapes-unused.db";
process.env.PLATFORM_DB_URL = "file:.test-api-shapes-unused-platform.db";
process.env.PLATFORM_DB_TOKEN = "";

const started = Date.now();
let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}
const fail = (msg) => {
  throw new Error(msg);
};
const sameList = (a, b, what) => {
  const x = [...a].sort().join(", ");
  const y = [...b].sort().join(", ");
  if (x !== y) fail(`${what}: shapes have [${x}], the code has [${y}]`);
};

const SHAPES_FILE = join(ROOT, "lib/admin/documents-api-shapes.js");
const shapesSource = await readFile(SHAPES_FILE, "utf8");

// ---- 1. data only ---------------------------------------------------------------

check("the shapes file imports nothing and holds no code", () => {
  const code = shapesSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  if (/^\s*import\b/m.test(code) || /\bimport\s*\(/.test(code)) fail("it has an import");
  if (/\brequire\s*\(/.test(code)) fail("it calls require");
  if (/\bexport\s+(?:\*|\{[^}]*\})\s+from\b/.test(code)) fail("it re-exports from another module");
  if (/["']node:/.test(code)) fail("it names a node: module");
  if (/=>|\bfunction\b|\bclass\b|\bnew\s+[A-Z]/.test(code)) fail("it holds a function, class or constructor: it must be data only");
  if (/\bprocess\.|\bglobalThis\b|\bawait\b/.test(code)) fail("it reads the runtime");
});

// Loaded only after the source check, so a file that imports something fails
// that check with its own words first.
let Sh = {};
try {
  Sh = await import(pathToFileURL(SHAPES_FILE).href);
} catch (e) {
  failures.push(`the shapes file doesn't load: ${e.message}`);
}
const { SHAPES, COMMON, SHAPES_VERSION } = Sh;


const read = (p) => readFile(join(ROOT, p), "utf8");
const apiSource = await read("lib/admin/documents-api.js");
const issuesSource = await read("lib/cms/issues.js");
const docFiles = (await readdir(join(ROOT, "lib/documents"))).filter((f) => f.endsWith(".js")).sort();
const docSources = Object.fromEntries(await Promise.all(docFiles.map(async (f) => [f, await read(`lib/documents/${f}`)])));
const serviceSource = docSources["service.js"];
const publishSource = docSources["publish.js"];
const versionsSource = docSources["versions.js"];
// P3-COMMIT: the build helpers moved from publish.js to build.js, and later
// items may move more. Checks on "the publish code" read every lib/documents
// file together, so a move between files never turns this suite red.
const documentsSource = docFiles.map((f) => docSources[f]).join("\n");
// Where the API's codes come from today.
const EMITTERS = { "lib/admin/documents-api.js": apiSource, "lib/cms/issues.js": issuesSource, ...Object.fromEntries(docFiles.map((f) => [`lib/documents/${f}`, docSources[f]])) };

// Codes phase 3 adds (plan section 2 and the P3 briefs). Every other code a
// "p3" outcome uses must already exist.
const NEW_CODES = new Set(["NOT_BUILT", "REPUBLISH_CONFIRM_NEEDED", "FIRST_PUBLISH_NEEDS_HOME", "LINKS_TO_UNPUBLISHED", "TOO_MANY_KEPT", "CANNOT_TAKE_OFFLINE"]);

// ---- walking the shapes ------------------------------------------------------------

const outcomesOf = (op) => (op.sameOutcomesAs ? SHAPES[op.sameOutcomesAs]?.outcomes : op.outcomes);
const allOutcomes = [];
for (const [name, o] of Object.entries(COMMON?.outcomes || {})) allOutcomes.push({ where: `COMMON.${name}`, o });
for (const [opName, op] of Object.entries(SHAPES || {})) {
  if (op.sameOutcomesAs) continue;
  for (const [name, o] of Object.entries(op.outcomes || {})) allOutcomes.push({ where: `${opName}.${name}`, o });
}

// "rows[].note" -> does the example have it? ("[]" = the first element)
function hasPath(value, path) {
  let cur = [value];
  for (const part of path.split(".")) {
    const isArr = part.endsWith("[]");
    const key = isArr ? part.slice(0, -2) : part;
    const next = [];
    for (const v of cur) {
      if (v === null || typeof v !== "object" || !Object.hasOwn(v, key)) continue;
      const got = v[key];
      if (isArr) {
        if (!Array.isArray(got)) continue;
        next.push(...got);
      } else next.push(got);
    }
    if (!next.length) return false;
    cur = next;
  }
  return true;
}
// Keys of a body with phase 3 additions removed (top level, or the first
// element of a listed array), for comparing a p2 outcome with today's code.
function keysWithout(obj, added, prefix = "") {
  const drop = new Set(added.filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes(".")).map((p) => p.slice(prefix.length)));
  return Object.keys(obj).filter((k) => !drop.has(k));
}

check("SHAPES_VERSION is 1 and every operation is well formed", () => {
  if (SHAPES_VERSION !== 1) fail(`SHAPES_VERSION is ${SHAPES_VERSION}`);
  if (!SHAPES || typeof SHAPES !== "object") fail("SHAPES is missing");
  for (const [name, op] of Object.entries(SHAPES)) {
    if (!["storefront.read", "storefront.write", "storefront.publish"].includes(op.access)) fail(`${name}: access is ${op.access}`);
    if (!op.request || !Object.hasOwn(op.request, name)) fail(`${name}: its request example doesn't carry the ${name} key`);
    for (const p of op.requestOptional || []) if (!hasPath(op.request, p)) fail(`${name}: requestOptional ${p} isn't in the request example`);
    const outs = outcomesOf(op);
    if (!outs || !Object.keys(outs).length) fail(`${name}: no outcomes`);
    if (!Object.values(outs).some((o) => o.status === 200)) fail(`${name}: no 200 outcome`);
  }
});

// The operations the plan names for phase 3 (P3-COMMIT brief, part 7).
check("every operation of today and of phase 3 has its entry", () => {
  const want = [
    "getDocument", "listDocuments", "listHistory", "createDocument", "saveDraft", "discardDraft", "restoreVersion", "archive", "publish", "publishSet",
    "unpublish", "undo", "undoSet", "listRecentlyPublished", "listChanges", "keepLiveSection", "keepAsEarlierDraft",
  ];
  sameList(Object.keys(SHAPES), want, "operations");
});

// ---- 2. outcomes well formed ------------------------------------------------------

check("every outcome has a status, since, a body, and paths that exist", () => {
  for (const { where, o } of allOutcomes) {
    if (!Number.isInteger(o.status) || o.status < 200 || o.status > 599) fail(`${where}: status ${o.status}`);
    if (o.since !== "p2" && o.since !== "p3") fail(`${where}: since is ${o.since}`);
    if (!o.body || typeof o.body !== "object" || Array.isArray(o.body)) fail(`${where}: no body`);
    if (o.status === 200) {
      if (o.body.ok !== true) fail(`${where}: a 200 without ok: true`);
      if ("code" in o.body || "error" in o.body) fail(`${where}: a 200 with a code or error`);
    } else {
      if (typeof o.body.error !== "string" || !o.body.error) fail(`${where}: a refusal without error words`);
      // 401 and 403 come from requireAdmin, which sends no code
      if (o.status !== 401 && o.status !== 403 && !/^[A-Z][A-Z_]+$/.test(o.body.code || "")) fail(`${where}: code ${o.body.code}`);
    }
    for (const p of [...(o.optional || []), ...(o.addedInPhase3 || [])]) if (!hasPath(o.body, p)) fail(`${where}: ${p} is listed but the example has no such key`);
    if (o.since === "p3" && o.addedInPhase3) fail(`${where}: a p3 outcome lists addedInPhase3 (it is new as a whole)`);
  }
});

check("no founder-facing words carry a code, hash or id", () => {
  const words = [];
  const walk = (v, key) => {
    if (typeof v === "string" && ["error", "message", "words", "actionWords", "note", "reason", "where"].includes(key)) words.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  for (const { o } of allOutcomes) walk(o.body);
  for (const w of words) if (/\b(?:doc|ver|log|set|rel|h)_[A-Za-z0-9]+|\b[A-Z]{2,}_[A-Z_]+\b/.test(w)) fail(`"${w}"`);
});

// ---- 3. codes against today's code ---------------------------------------------------

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function statusesFor(code) {
  const out = new Set();
  let found = false;
  for (const src of Object.values(EMITTERS)) {
    if (!new RegExp(`["']${esc(code)}["']`).test(src)) continue;
    found = true;
    for (const re of [
      new RegExp(`DocumentError\\(\\s*(\\d{3})\\s*,\\s*["']${esc(code)}["']`, "g"),
      new RegExp(`status:\\s*(\\d{3})\\s*,\\s*(?:body:\\s*\\{[^}]*?)?code:\\s*["']${esc(code)}["']`, "g"),
    ]) {
      for (const m of src.matchAll(re)) out.add(Number(m[1]));
    }
  }
  // NotFoundError sets its own code and status
  if (code === "NOT_FOUND" && /this\.code = "NOT_FOUND";\s*this\.status = 404;/.test(issuesSource)) out.add(404);
  // ValidationError likewise
  if (code === "VALIDATION_FAILED" && /this\.code = "VALIDATION_FAILED";\s*this\.status = 422;/.test(issuesSource)) out.add(422);
  return found ? out : null;
}

check("every code the API gives today is copied exactly, with its status", () => {
  for (const { where, o } of allOutcomes) {
    const code = o.body.code;
    if (!code) continue;
    const statuses = statusesFor(code);
    if (o.since === "p2") {
      if (!statuses) fail(`${where}: ${code} is marked as today's, but no emitter has that code (renamed?)`);
      if (statuses.size && !statuses.has(o.status)) fail(`${where}: ${code} is ${o.status} here, the code says ${[...statuses].join(" or ")}`);
    } else if (!statuses && !NEW_CODES.has(code)) {
      fail(`${where}: ${code} is neither a code of today nor one of phase 3's new codes`);
    } else if (statuses && NEW_CODES.has(code)) {
      fail(`${where}: ${code} is listed as new but the code already emits it`);
    }
  }
});

check("the new phase 3 codes are each used by an outcome", () => {
  const used = new Set(allOutcomes.map(({ o }) => o.body.code).filter(Boolean));
  for (const c of NEW_CODES) if (!used.has(c)) fail(`${c} has no outcome`);
});

// The codes today's documents API can answer, from its sources, each have an
// outcome here (nothing missing from the contract).
check("every DocumentError code of today has an outcome", () => {
  const used = new Set(allOutcomes.filter(({ o }) => o.since === "p2").map(({ o }) => o.body.code));
  const emitted = new Set();
  for (const src of [apiSource, ...Object.values(docSources)]) {
    for (const m of src.matchAll(/DocumentError\(\s*\d{3}\s*,\s*"([A-Z_]+)"/g)) emitted.add(m[1]);
    for (const m of src.matchAll(/status:\s*\d{3}\s*,\s*body:\s*\{[^}]*?code:\s*"([A-Z_]+)"/g)) emitted.add(m[1]);
    for (const m of src.matchAll(/code:\s*"([A-Z_]+)"\s*,\s*\n?\s*error:/g)) emitted.add(m[1]); // publish conflicts
    for (const m of src.matchAll(/error:\s*UNREADABLE,\s*code:\s*"([A-Z_]+)"/g)) emitted.add(m[1]);
  }
  const ce = /CART_LOCKED_CODE = "([A-Z_]+)"/.exec(serviceSource);
  if (ce) emitted.add(ce[1]);
  for (const m of issuesSource.matchAll(/\{ status: \d{3}, code: "([A-Z_]+)" \}/g)) emitted.add(m[1]);
  if (emitted.size < 20) fail(`only ${emitted.size} codes found in the sources: the scan is broken`);
  const missing = [...emitted].filter((c) => !used.has(c));
  if (missing.length) fail(`no p2 outcome for ${missing.join(", ")}`);
});

// ---- 4. fields against today's code ----------------------------------------------------

const Issues = await import("../lib/cms/issues.js");

check("ISSUE has exactly lib/cms/issues.js ISSUE_KEYS", () => sameList(Object.keys(Sh.ISSUE), Issues.ISSUE_KEYS, "issue keys"));
check("ISSUE is what issue() makes", () => sameList(Object.keys(Sh.ISSUE), Object.keys(Issues.issue({ code: "X", message: "m" })), "issue() keys"));
check("PUBLISH_ISSUE is ISSUE plus level, anchor, where and actions", () => {
  sameList(Object.keys(Sh.PUBLISH_ISSUE), [...Issues.ISSUE_KEYS, "level", "anchor", "where", "actions"], "publish issue keys");
  if (!["blocks", "warns", "inherited"].includes(Sh.PUBLISH_ISSUE.level)) fail("level");
  for (const a of Sh.PUBLISH_ISSUE.actions) if (!["hideSection", "removeSection", "removeItem", "publishBoth"].includes(a.type)) fail(`action ${a.type}`);
});

check("validationFailed is validationBody() exactly", () => {
  const o = COMMON.outcomes.validationFailed;
  const real = Issues.validationBody(o.body.issues);
  sameList(Object.keys(o.body), Object.keys(real), "422 keys");
  if (JSON.stringify(real) !== JSON.stringify(o.body)) fail(`422 body differs: ${JSON.stringify(real)}`);
});

check("failure() bodies and words match COMMON (save words)", () => {
  const nf = Issues.failure(new Issues.NotFoundError(COMMON.outcomes.notFound.body.error));
  if (nf.status !== 404 || JSON.stringify(nf.body) !== JSON.stringify(COMMON.outcomes.notFound.body)) fail(`404: ${JSON.stringify(nf.body)}`);
  const want = { databaseNotReady: "schema", databaseUnavailable: "unavailable", databaseError: "database", saveConflict: "conflict", internalError: "internal" };
  for (const [name, kind] of Object.entries(want)) {
    const o = COMMON.outcomes[name];
    const { status, code } = Issues.INFRA_CODES[kind];
    const body = { error: Issues.infraMessage(kind, "save"), code, retryable: kind !== "schema" };
    if (o.status !== status) fail(`${name}: status ${o.status}, code says ${status}`);
    if (JSON.stringify(o.body) !== JSON.stringify(body)) fail(`${name}: ${JSON.stringify(o.body)} vs ${JSON.stringify(body)}`);
  }
  const internal = Issues.failure(new Error("boom"), { doing: "save" });
  sameList(Object.keys(COMMON.outcomes.internalError.body), Object.keys(internal.body), "failure() keys");
});

check("PUBLISH_FAILED uses the publish words of infraMessage", () => {
  const o = SHAPES.publish.outcomes.failed;
  if (o.body.error !== Issues.infraMessage("internal", "publish")) fail(o.body.error);
});

// The keys a source function's returned object literal has, by its own text.
function literalKeys(src, startMarker, indent) {
  const at = src.indexOf(startMarker);
  if (at < 0) fail(`can't find ${startMarker}`);
  const rest = src.slice(at);
  const end = rest.indexOf("\n}\n");
  const fn = end < 0 ? rest : rest.slice(0, end);
  const keys = [...fn.matchAll(new RegExp(`^ {${indent}}(\\w+)(?::|,$)`, "gm"))].map((m) => m[1]);
  if (!keys.length) fail(`no keys found after ${startMarker}`);
  return keys;
}

check("DOCUMENT is service.js fromRow() plus publicDocument()", () => {
  const row = literalKeys(serviceSource, "function fromRow(r) {", 4);
  const pub = /export function publicDocument\(d\) \{[\s\S]*?return \{ \.\.\.d, ([^}]*)\};/.exec(serviceSource);
  if (!pub) fail("can't read publicDocument()");
  const extra = [...pub[1].matchAll(/(\w+):/g)].map((m) => m[1]);
  sameList(Object.keys(Sh.DOCUMENT), [...row, ...extra], "document keys");
  // publish.js reads the same columns into the same keys (its conflicts' current)
  sameList(literalKeys(publishSource, "function fromRow(r) {", 4), row, "publish.js fromRow keys");
});

check("CURRENT is DOCUMENT plus updatedBy and updatedByName", () => sameList(Object.keys(Sh.CURRENT), [...Object.keys(Sh.DOCUMENT), "updatedBy", "updatedByName"], "current keys"));

check("getDocument and listDocuments rows match service.js (access is phase 3)", () => {
  const ok = SHAPES.getDocument.outcomes.ok;
  sameList(keysWithout(ok.body.document, ok.addedInPhase3, "document."), Object.keys(Sh.DOCUMENT), "getDocument document");
  sameList(Object.keys(ok.body.document.access), ["canPublish", "reason"], "access");
  const lo = SHAPES.listDocuments.outcomes.ok;
  const row = literalKeys(serviceSource, "return r.rows.map((d) => ({", 4);
  sameList(keysWithout(lo.body.documents[0], lo.addedInPhase3, "documents[]."), row, "listDocuments row");
  if (!/body: \{ ok: true, documents: await Docs\.listDocuments/.test(apiSource)) fail("listDocuments 200 body changed");
  if (!/body: \{ ok: true, document: Docs\.publicDocument\(await Docs\.getDocument/.test(apiSource)) fail("getDocument 200 body changed");
});

check("listHistory versions match versions.js listVersions()", () => {
  const row = literalKeys(versionsSource, "return r.rows.map((v) => ({", 4);
  sameList(Object.keys(SHAPES.listHistory.outcomes.ok.body.versions[0]), row, "listHistory version");
  sameList(Object.keys(SHAPES.listHistory.outcomes.ok.body), ["ok", "versions"], "listHistory 200");
});

check("draft writes answer { ok, document, issues }", () => {
  if (!/body: \{ ok: true, document: Docs\.publicDocument\(r\.document\), issues: r\.issues \|\| \[\] \}/.test(apiSource)) fail("the write 200 body changed in documents-api.js");
  for (const op of ["createDocument", "saveDraft", "discardDraft", "restoreVersion", "archive"]) sameList(Object.keys(SHAPES[op].outcomes.ok.body), ["ok", "document", "issues"], `${op} 200`);
});

check("publish answers today's keys, plus liveUrl and undo per item", () => {
  const m = /body: \{ ok: true, (release: p\.release[^}]*)\}/.exec(apiSource);
  if (!m) fail("can't read the publish 200 body");
  const keys = ["ok", ...[...m[1].matchAll(/(\w+):/g)].map((x) => x[1])];
  const ok = SHAPES.publish.outcomes.ok;
  sameList(Object.keys(ok.body), keys, "publish 200");
  const item = /published: build\.documents\.map\(\(d\) => \(\{ ([^}]*) \}\)\)/.exec(documentsSource);
  if (!item) fail("can't read a published item");
  sameList(keysWithout(ok.body.published[0], ok.addedInPhase3, "published[]."), [...item[1].matchAll(/(\w+):/g)].map((x) => x[1]), "published item");
  sameList(Object.keys(ok.body.published[0].undo), ["id", "revision", "logId"], "undo args");
  if (!ok.body.published[0].liveUrl.startsWith("/api/preview?exit=1&to=") || /token/i.test(ok.body.published[0].liveUrl)) fail("liveUrl");
  sameList(Object.keys(SHAPES.publish.outcomes.validationFailed.body), [...Object.keys(Issues.validationBody([])), "documents"], "publish 422");
});

check("publish conflicts carry what conflictError() sends", () => {
  const o = SHAPES.publish.outcomes.changed;
  const fn = /const stale = \(cur\) => \(\{([\s\S]*?)\}\);/.exec(documentsSource);
  if (!fn) fail("can't read publish.js stale()");
  sameList(Object.keys(o.body.conflicts[0]), [...fn[1].matchAll(/^\s+(\w+):/gm)].map((x) => x[1]), "conflict entry");
  if (!/\{ conflicts: list, \.\.\.\(list\.length === 1 \? \{ current: first\.current \} : \{\}\) \}/.test(documentsSource)) fail("conflictError() changed");
});

check("slug refusals carry slug and other (and document on publish)", () => {
  if (!/\{ slug, other \}/.test(serviceSource)) fail("service.js slugTaken extra changed");
  if (!/\{ slug, document: p\.doc\.id, other \}/.test(documentsSource)) fail("slugClash extra changed (lib/documents)");
  sameList(keysWithout(SHAPES.saveDraft.outcomes.slugTaken.body, []), ["error", "code", "slug", "other"], "save SLUG_TAKEN");
  sameList(keysWithout(SHAPES.publish.outcomes.slugTaken.body, []), ["error", "code", "slug", "document", "other"], "publish SLUG_TAKEN");
  // today's other is { id, title }; label is phase 3, title is kept
  sameList(keysWithout(SHAPES.saveDraft.outcomes.slugTaken.body.other, ["label"]), ["id", "title"], "other");
});

check("constant words are copied exactly", () => {
  const constant = [
    ["saveDraft", "legacy"], ["publish", "legacy"], ["saveDraft", "revisionRequired"], ["publish", "revisionRequired"], ["publish", "reviewRequired"],
    ["publish", "nothingToPublish"], ["saveDraft", "cartLocked"], ["publish", "busy"], ["publish", "unknown"], ["publish", "deleted"], ["publish", "storeUsesReleases"],
  ];
  const all = Object.values(EMITTERS).join("\n");
  for (const [op, name] of constant) {
    const w = SHAPES[op].outcomes[name].body.error;
    if (!all.includes(JSON.stringify(w)) && !all.includes(`"${w}"`)) fail(`${op}.${name}: "${w}" is not in the code`);
  }
  if (!apiSource.includes(JSON.stringify(COMMON.outcomes.malformed.body.error))) fail("UNREADABLE words");
});

check("error bodies of DocumentError refusals carry today's extra fields", () => {
  sameList(Object.keys(SHAPES.publish.outcomes.deleted.body), ["error", "code", "missing"], "DOCUMENT_DELETED");
  if (!/"DOCUMENT_DELETED", DELETED_MESSAGE, \{ missing:/.test(documentsSource)) fail("DOCUMENT_DELETED extra changed");
  sameList(Object.keys(SHAPES.publish.outcomes.unknown.body), ["error", "code", "release"], "PUBLISH_UNKNOWN");
  if (!/"PUBLISH_UNKNOWN", UNKNOWN_MESSAGE, \{ release: \{ id: build\.releaseId \} \}/.test(documentsSource)) fail("PUBLISH_UNKNOWN extra changed");
  sameList(Object.keys(SHAPES.publish.outcomes.failed.body), ["error", "code", "reason"], "PUBLISH_FAILED");
  if (!/"PUBLISH_FAILED", infraMessage\("internal", "publish"\), \{ reason:/.test(documentsSource)) fail("PUBLISH_FAILED extra changed");
  for (const n of ["notPublishable", "publishNotAvailable"]) {
    sameList(Object.keys(SHAPES.publish.outcomes[n].body), ["error", "code", "document"], n);
  }
  if ((documentsSource.match(/\{ document: d\.id \}/g) || []).length !== 2) fail("NOT_PUBLISHABLE / PUBLISH_NOT_AVAILABLE extra changed");
  if (!/"DOCUMENT_ARCHIVED", `[^`]*`, \{ current: publicDocument\(current\) \}/.test(serviceSource)) fail("DOCUMENT_ARCHIVED extra changed");
  if (!/"DOCUMENT_EXISTS", `[^`]*`, \{ current: publicDocument\(cur\) \}/.test(serviceSource)) fail("DOCUMENT_EXISTS extra changed");
});

const { parseDocumentsOperation } = await import("../lib/admin/documents-api.js");
check("the request of every operation of today parses with today's parser", () => {
  for (const [name, op] of Object.entries(SHAPES)) {
    const today = Object.values(outcomesOf(op)).some((o) => o.since === "p2" && o.status === 200);
    if (!today) continue;
    const r = parseDocumentsOperation(op.request);
    if (r.error || r.op.kind !== name) fail(`${name}: ${JSON.stringify(r)}`);
  }
});

console.log(`${passed} passed, ${failures.length} failed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
for (const f of failures) console.error(`✗ ${f}`);
process.exit(failures.length ? 1 : 0);
