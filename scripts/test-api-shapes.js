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
//
// P3-COMMIT (the review of P3-SCAFFOLD): source checks read every
// lib/documents file together, so moving code between those files keeps this
// green; the dispatcher's 200 bodies are compared by their keys, read from the
// object literals, never by their exact text; a key the shapes mark as added
// in phase 3 may be present or not. The real answers are compared with these
// shapes, key by key, in scripts/test-publish-service.js.
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
// The code's keys must be the shapes' keys, except that a key the shapes mark
// as added in phase 3 (or optional) may be there or not.
const keysBetween = (shapeKeys, codeKeys, maybe, what) => {
  const may = new Set(maybe);
  const extra = codeKeys.filter((k) => !shapeKeys.includes(k));
  const missing = shapeKeys.filter((k) => !may.has(k) && !codeKeys.includes(k));
  if (extra.length || missing.length) fail(`${what}: shapes have [${[...shapeKeys].sort().join(", ")}], the code has [${[...codeKeys].sort().join(", ")}]`);
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
const authSource = await read("lib/admin-auth.js");
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
// NOT_BUILT is no longer new: P3-COMMIT's NotBuiltError emits it.
// P3-CHECKS: BUILT_CODES are new codes the code now emits: each must be
// emitted, with its outcome's status (a renamed one fails). NEW_CODES are not
// built yet (P3-CHANGES): emitted or not, a status must match.
// P3-UNDO: CANNOT_TAKE_OFFLINE is emitted now (lib/documents/undo.js), so it
// is built.
const BUILT_CODES = new Set(["REPUBLISH_CONFIRM_NEEDED", "FIRST_PUBLISH_NEEDS_HOME", "LINKS_TO_UNPUBLISHED", "CANNOT_TAKE_OFFLINE"]);
const NEW_CODES = new Set([...BUILT_CODES, "TOO_MANY_KEPT"]);

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
      // a DocumentError subclass (P3-COMMIT NotBuiltError)
      new RegExp(`super\\(\\s*(\\d{3})\\s*,\\s*["']${esc(code)}["']`, "g"),
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
    } else if (!statuses && BUILT_CODES.has(code)) {
      fail(`${where}: ${code} is built in phase 3 (P3-CHECKS), but no emitter has that code (renamed?)`);
    } else if (BUILT_CODES.has(code) && !statuses.has(o.status)) {
      fail(`${where}: ${code} is ${o.status} here, the code says ${[...statuses].join(" or ") || "no status"}`);
    } else if (statuses && statuses.size && !statuses.has(o.status)) {
      // a p3 outcome reusing a code of today keeps its status
      fail(`${where}: ${code} is ${o.status} here, the code says ${[...statuses].join(" or ")}`);
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
  // a phase 3 code that is built has its p3 outcome
  const used = new Set(allOutcomes.filter(({ o }) => o.since === "p2" || NEW_CODES.has(o.body.code)).map(({ o }) => o.body.code));
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
  sameList(Sh.PUBLISH_ACTION_TYPES, ["hideSection", "removeSection", "removeItem", "publishBoth", "openField"], "action types");
  for (const a of Sh.PUBLISH_ISSUE.actions) if (!Sh.PUBLISH_ACTION_TYPES.includes(a.type)) fail(`action ${a.type}`);
});

// P3-CHECKS: what lib/documents/checks.js decorate() and publish.js send.
check("P3-CHECKS: a decorated issue is PUBLISH_ISSUE's keys; every action type the code makes is in the contract", () => {
  const src = docSources["checks.js"];
  if (!src) fail("lib/documents/checks.js is missing");
  const at = src.indexOf("export function decorate(");
  if (at < 0) fail("can't find decorate()");
  const ret = src.indexOf("return {", at);
  const lit = literalParts(balanced(src, ret + "return ".length));
  sameList(lit.keys, Object.keys(Sh.PUBLISH_ISSUE), "decorate() keys");
  // the action types it writes: type: "…", and the two of a ternary
  const actionsSrc = src.slice(src.indexOf("export function actionsFor("), src.indexOf("export function levelOf("));
  const made = new Set([...actionsSrc.matchAll(/"([a-z]+(?:Section|Item|Both|Field))"/g)].map((m) => m[1]));
  if (made.size < 5) fail(`only ${[...made].join(", ")} action types found: the scan is broken`);
  for (const ty of made) if (!Sh.PUBLISH_ACTION_TYPES.includes(ty)) fail(`checks.js makes action ${ty}, which the contract doesn't list`);
  for (const ty of Sh.PUBLISH_ACTION_TYPES) if (!made.has(ty)) fail(`the contract lists action ${ty}, which checks.js never makes`);
  for (const lvl of ["blocks", "warns", "inherited"]) if (!src.includes(`"${lvl}"`)) fail(`level ${lvl} is not in checks.js`);
});

check("P3-CHECKS: the new refusals carry the contract's extra fields, and the offer items its keys", () => {
  const o = SHAPES.publish.outcomes;
  sameList(Object.keys(o.republishConfirmNeeded.body), ["error", "code", "id"], "REPUBLISH_CONFIRM_NEEDED");
  if (!/"REPUBLISH_CONFIRM_NEEDED", REPUBLISH_MESSAGE, \{ id: p\.doc\.id \}/.test(publishSource)) fail("REPUBLISH_CONFIRM_NEEDED extra changed");
  sameList(Object.keys(o.firstPublishNeedsHome.body), ["error", "code", "offer"], "FIRST_PUBLISH_NEEDS_HOME");
  sameList(Object.keys(o.firstPublishNoHome.body), ["error", "code", "offer"], "FIRST_PUBLISH_NEEDS_HOME, no home");
  if (!/"FIRST_PUBLISH_NEEDS_HOME", NEEDS_HOME_MESSAGE, \{ offer: \{ publishSet:/.test(publishSource)) fail("FIRST_PUBLISH_NEEDS_HOME extra changed");
  if (!/"FIRST_PUBLISH_NEEDS_HOME", NO_HOME_MESSAGE, \{ offer: null \}/.test(publishSource)) fail("FIRST_PUBLISH_NEEDS_HOME (no home) extra changed");
  sameList(Object.keys(o.linksToUnpublished.body), ["error", "code", "issues", "offer"], "LINKS_TO_UNPUBLISHED");
  if (!/"LINKS_TO_UNPUBLISHED", message, \{ issues: allIssues, offer \}/.test(publishSource)) fail("LINKS_TO_UNPUBLISHED extra changed");
  const item = /const offerItem = \(d\) => \((\{[^}]*\})\);/.exec(publishSource);
  if (!item) fail("can't read publish.js offerItem()");
  sameList(literalParts(item[1]).keys, Object.keys(Sh.OFFER.publishSet[0]), "offer item");
  for (const n of ["REPUBLISH_MESSAGE", "NEEDS_HOME_MESSAGE", "NO_HOME_MESSAGE"]) if (!new RegExp(`const ${n} = `).test(publishSource)) fail(`${n} is gone`);
  for (const [name, msg] of [["republishConfirmNeeded", "REPUBLISH_MESSAGE"], ["firstPublishNeedsHome", "NEEDS_HOME_MESSAGE"], ["firstPublishNoHome", "NO_HOME_MESSAGE"]]) {
    if (!publishSource.includes(`const ${msg} = ${JSON.stringify(o[name].body.error)};`)) fail(`${name}: "${o[name].body.error}" is not ${msg} in publish.js`);
  }
});

check("P3-CHECKS: publish conflicts name who changed it (current.updatedBy, current.updatedByName)", () => {
  if (!/current: \{ \.\.\.c\.current, updatedBy, updatedByName \}/.test(publishSource)) fail("withWho() no longer adds updatedBy and updatedByName");
  if (!/const NAMED = new Set\(\["DOCUMENT_CHANGED", "DRAFT_CHANGED", "PUBLISHED_ELSEWHERE"\]\)/.test(publishSource)) fail("the named conflicts changed");
  for (const n of ["changed", "draftChanged", "publishedElsewhere"]) {
    const ob = SHAPES.publish.outcomes[n];
    if ((ob.optional || []).some((x) => /updatedBy/.test(x)) || (ob.addedInPhase3 || []).some((x) => /updatedBy/.test(x))) fail(`${n}: updatedBy is sent now, so it must be required`);
    sameList(Object.keys(ob.body.current), Object.keys(Sh.CURRENT), `${n} current`);
  }
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

// The text of the balanced {…} that starts at `at` (strings and template
// literals skipped).
function balanced(src, at) {
  if (src[at] !== "{") fail(`expected { at ${at}`);
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  fail("unbalanced object literal");
}
// An object literal's own parts: { keys, spreads, values: {key: text} }.
function literalParts(text) {
  const inner = text.slice(1, -1);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < inner.length && inner[i] !== c; i++) if (inner[i] === "\\") i++;
      continue;
    }
    if ("{([".includes(c)) depth++;
    else if ("})]".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  const out = { keys: [], spreads: [], values: {} };
  for (const raw of parts.map((x) => x.trim()).filter(Boolean)) {
    if (raw.startsWith("...")) out.spreads.push(raw.slice(3));
    else {
      const m = /^(\w+)\s*(?::\s*([\s\S]*))?$/.exec(raw);
      if (!m) fail(`can't read "${raw.slice(0, 60)}"`);
      out.keys.push(m[1]);
      out.values[m[1]] = (m[2] ?? m[1]).trim();
    }
  }
  return out;
}
// The 200 body literal that follows `marker` in documents-api.js.
function bodyAfter(marker) {
  const at = apiSource.indexOf(marker);
  if (at < 0) fail(`can't find ${marker} in documents-api.js`);
  const b = apiSource.indexOf("body: {", at);
  if (b < 0) fail(`no body after ${marker}`);
  return literalParts(balanced(apiSource, b + "body: ".length));
}
// The case block of one operation in the dispatcher.
function caseBlock(kind) {
  const at = apiSource.indexOf(`case "${kind}": {`, apiSource.indexOf("export async function handleDocumentsPut"));
  if (at < 0) fail(`can't find the ${kind} case in the dispatcher`);
  return apiSource.slice(at, apiSource.indexOf("\n      }\n", at));
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

check("getDocument and listDocuments rows match service.js, plus access", () => {
  const ok = SHAPES.getDocument.outcomes.ok;
  sameList(keysWithout(ok.body.document, ok.addedInPhase3, "document."), Object.keys(Sh.DOCUMENT), "getDocument document");
  sameList(Object.keys(ok.body.document.access), ["canPublish", "reason"], "access");
  sameList(Object.keys(Sh.ACCESS), ["canPublish", "reason"], "ACCESS");
  const lo = SHAPES.listDocuments.outcomes.ok;
  const row = literalKeys(serviceSource, "return r.rows.map((d) => ({", 4);
  sameList(keysWithout(lo.body.documents[0], lo.addedInPhase3, "documents[]."), row, "listDocuments row");
  // the dispatcher's 200 bodies, by their keys
  const g = caseBlock("getDocument");
  const gb = literalParts(balanced(g, g.indexOf("body: {") + 6));
  keysBetween(Object.keys(ok.body), gb.keys, [], "getDocument 200");
  const gd = literalParts(gb.values.document);
  if (!gd.spreads.some((x) => /publicDocument\(/.test(x))) fail("getDocument's document is no longer publicDocument()");
  keysBetween(Object.keys(ok.body.document), [...Object.keys(Sh.DOCUMENT), ...gd.keys], ["access"], "getDocument document");
  const l = caseBlock("listDocuments");
  const lb = literalParts(balanced(l, l.indexOf("body: {") + 6));
  keysBetween(Object.keys(lo.body), lb.keys, [], "listDocuments 200");
  const mapAt = l.indexOf(".map((d) => ({");
  const lr = mapAt < 0 ? { keys: [], spreads: ["d"] } : literalParts(balanced(l, mapAt + ".map((d) => (".length));
  if (!lr.spreads.includes("d")) fail("a listDocuments row is no longer the service row");
  keysBetween(Object.keys(lo.body.documents[0]), [...row, ...lr.keys], ["access"], "listDocuments row");
  for (const w of [Sh.ACCESS.reason]) if (!apiSource.includes(JSON.stringify(w))) fail(`access reason "${w}" is not in documents-api.js`);
});

check("listHistory versions match versions.js listVersions()", () => {
  const row = literalKeys(versionsSource, "return r.rows.map((v) => ({", 4);
  sameList(Object.keys(SHAPES.listHistory.outcomes.ok.body.versions[0]), row, "listHistory version");
  sameList(Object.keys(SHAPES.listHistory.outcomes.ok.body), ["ok", "versions"], "listHistory 200");
});

check("draft writes answer { ok, document, issues }", () => {
  keysBetween(["ok", "document", "issues"], bodyAfter('slog("documents_write"').keys, [], "the write 200 in documents-api.js");
  for (const op of ["createDocument", "saveDraft", "discardDraft", "restoreVersion", "archive"]) sameList(Object.keys(SHAPES[op].outcomes.ok.body), ["ok", "document", "issues"], `${op} 200`);
});

check("publish answers today's keys, plus liveUrl and undo per item", () => {
  const ok = SHAPES.publish.outcomes.ok;
  keysBetween(Object.keys(ok.body), bodyAfter('slog("documents_publish_api"').keys, [], "publish 200");
  const at = documentsSource.indexOf("published: build.documents.map((d) => ({");
  if (at < 0) fail("can't read a published item");
  const item = literalParts(balanced(documentsSource, at + "published: build.documents.map((d) => (".length));
  // P3-CHECKS: liveUrl and undo are sent, so they are required now
  if ((ok.addedInPhase3 || []).length) fail(`publish 200 still lists addedInPhase3 ${ok.addedInPhase3.join(", ")}: everything is sent now`);
  keysBetween(Object.keys(ok.body.published[0]), item.keys, [], "published item");
  if (!/liveUrl: placeOf\(d\.id\)/.test(documentsSource) || !/liveExitUrl\(livePath\(p\.doc\.type, p\.body\?\.meta\)\)/.test(documentsSource)) fail("liveUrl is no longer liveExitUrl(livePath(type, meta))");
  sameList(literalParts(item.values.undo).keys, ["id", "revision", "logId"], "the code's undo args");
  sameList(Object.keys(ok.body.published[0].undo), ["id", "revision", "logId"], "undo args");
  if (!ok.body.published[0].liveUrl.startsWith("/api/preview?exit=1&to=") || /token/i.test(ok.body.published[0].liveUrl)) fail("liveUrl");
  sameList(Object.keys(SHAPES.publish.outcomes.validationFailed.body), [...Object.keys(Issues.validationBody([])), "documents", "offer"], "publish 422");
  if (!/documents: blocked\.map\(\(d\) => \(\{ id: d\.id, label: d\.label \}\)\), \.\.\.\(offer \? \{ offer \} : \{\}\)/.test(publishSource)) fail("refusedForIssues() extra changed");
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
  if (!apiSource.includes(JSON.stringify(COMMON.outcomes.malformedPublish.body.error))) fail("UNREADABLE publish words");
  for (const op of ["listChanges", "listRecentlyPublished"]) if (!apiSource.includes(JSON.stringify(SHAPES[op].outcomes.legacy.body.error))) fail(`${op}.legacy words are not in documents-api.js`);
  if (!Object.values(EMITTERS).join("\n").includes(JSON.stringify(COMMON.outcomes.notBuilt.body.error))) fail("NOT_BUILT words are not in the code");
});

// requireAdmin's own words (the shapes copy them; they carry no code)
check("401 and 403 words are lib/admin-auth.js's", () => {
  if (!authSource.includes(JSON.stringify(COMMON.outcomes.unauthorized.body.error))) fail(`401 "${COMMON.outcomes.unauthorized.body.error}" is not in admin-auth.js`);
  const m = /error: `Your role \(\$\{user\.role\}\) can't do that`/.exec(authSource);
  if (!m) fail("admin-auth.js no longer says `Your role (${user.role}) can't do that`");
  if (COMMON.outcomes.forbidden.body.error !== "Your role (staff) can't do that") fail(`403 example: ${COMMON.outcomes.forbidden.body.error}`);
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
// P3-COMMIT parses every phase 3 operation too.
check("the request of every operation parses, and dryRun, logId and confirmRepublish are copied", () => {
  for (const [name, op] of Object.entries(SHAPES)) {
    const r = parseDocumentsOperation(op.request);
    if (r.error || r.op.kind !== name) fail(`${name}: ${JSON.stringify(r)}`);
  }
  const p = (b) => parseDocumentsOperation(b).op;
  if (p(SHAPES.publish.request).confirmRepublish !== true) fail("publish confirmRepublish");
  if (p(SHAPES.publishSet.request).items[1].confirmRepublish !== true) fail("publishSet confirmRepublish");
  const u = p(SHAPES.undo.request);
  if (u.logId !== "log_1" || u.dryRun !== false || u.revision !== 4) fail(`undo: ${JSON.stringify(u)}`);
  if (p({ undo: { id: "doc_home", logId: "log_1", dryRun: true }, revision: 4 }).dryRun !== true) fail("undo dryRun");
  const s = p({ undoSet: { ...SHAPES.undoSet.request.undoSet, dryRun: true } });
  if (s.dryRun !== true || s.setId !== "set_1" || s.members[1].logId !== "log_2") fail(`undoSet: ${JSON.stringify(s)}`);
  if (p({ unpublish: { id: "doc_x", dryRun: true }, revision: 2 }).dryRun !== true) fail("unpublish dryRun");
  if (p(SHAPES.listRecentlyPublished.request).limit !== 20 || p({ listRecentlyPublished: {} }).limit !== 20) fail("listRecentlyPublished limit");
  for (const bad of [{ listRecentlyPublished: { limit: 0 } }, { listRecentlyPublished: { limit: 51 } }, { undo: { id: "doc_home" }, revision: 1 }, { undoSet: { setId: "s", members: [] } }, { publish: { id: "d", confirmRepublish: "yes" }, revision: 1 }]) {
    const r = parseDocumentsOperation(bad);
    if (r.code !== "MALFORMED") fail(`not refused: ${JSON.stringify(bad)}`);
  }
});

console.log(`${passed} passed, ${failures.length} failed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
for (const f of failures) console.error(`✗ ${f}`);
process.exit(failures.length ? 1 : 0);
