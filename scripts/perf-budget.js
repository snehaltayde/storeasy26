// PERF-04: numbers and budgets. Pure functions, unit-tested in
// scripts/test-perf-tools.js.
//
// Budgets are written down only from hosted numbers (spec PERF-04: "Only then
// fix the budgets"). This module can compare a run with a budget file and
// fail when a number is over, and it refuses a budget file that says its
// numbers came from a local run. docs/perf/budgets.json ships with no budgets.

// Nearest-rank percentile: the smallest value with at least p% of the values
// at or below it. p95 of 50 runs is the 48th fastest.
export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * v.length));
  return v[rank - 1];
}

export function summarize(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  const round = (x) => Math.round(x * 10) / 10;
  return { runs: v.length, p50: round(percentile(v, 50)), p95: round(percentile(v, 95)), min: round(Math.min(...v)), max: round(Math.max(...v)) };
}

// "ttfb.p95" → run.routes[i].ttfb.p95, and so on. Every metric a budget may name.
export const METRICS = {
  "ttfb.p50": (r) => r.ttfb?.p50,
  "ttfb.p95": (r) => r.ttfb?.p95,
  "total.p50": (r) => r.total?.p50,
  "total.p95": (r) => r.total?.p95,
  "cold.ttfb": (r) => r.cold?.ttfb,
  "cold.total": (r) => r.cold?.total,
  "bytes.wire": (r) => r.bytes?.wire,
  "bytes.decoded": (r) => r.bytes?.decoded,
  "db.reads": (r) => r.db?.warm?.reads,
  "db.statements": (r) => r.db?.warm?.statements,
  "db.roundTrips": (r) => r.db?.warm?.roundTrips,
  "db.rowsRead": (r) => r.db?.warm?.rowsRead,
  "db.bytesDown": (r) => r.db?.warm?.bytesDown,
  "db.firstRequestReads": (r) => r.db?.first?.reads,
};

export class BudgetFileError extends Error {}

// A budget file:
//   { "basis": "hosted" | "test", "runKind": "hosted" | "local",
//     "budgets": [ { "route": "home", "metric": "ttfb.p95", "max": 400 } ] }
// basis "hosted": real budgets, set from hosted measurements.
// basis "test":   only to prove this check works; never a real budget.
// Anything else (a "local" basis in particular) is refused: no budget may be
// claimed from local measurements alone.
export function readBudgetFile(text, name = "budget file") {
  let b;
  try {
    b = JSON.parse(text);
  } catch (e) {
    throw new BudgetFileError(`${name} isn't valid JSON (${e.message}).`);
  }
  if (!b || typeof b !== "object") throw new BudgetFileError(`${name} must be a JSON object.`);
  if (!Array.isArray(b.budgets)) throw new BudgetFileError(`${name} needs a "budgets" list (it may be empty).`);
  if (!b.budgets.length) return { ...b, placeholder: true };
  if (b.basis !== "hosted" && b.basis !== "test") {
    throw new BudgetFileError(
      b.basis === "local"
        ? `${name} says its budgets come from local measurements. PERF-04 sets budgets only from hosted numbers, so this file can't be used. Measure on the hosted runtime first (OQ-19).`
        : `${name} must say where its budgets come from: "basis": "hosted" (real budgets) or "test" (only to check the checker).`,
    );
  }
  if (b.runKind !== "hosted" && b.runKind !== "local") throw new BudgetFileError(`${name} must say which runs it applies to: "runKind": "hosted" or "local".`);
  for (const [i, x] of b.budgets.entries()) {
    if (!x || typeof x.route !== "string" || !x.route) throw new BudgetFileError(`${name}, budget ${i + 1}: "route" is missing.`);
    if (!Object.hasOwn(METRICS, x.metric)) throw new BudgetFileError(`${name}, budget ${i + 1}: unknown metric "${x.metric}". Known: ${Object.keys(METRICS).join(", ")}.`);
    if (!Number.isFinite(x.max)) throw new BudgetFileError(`${name}, budget ${i + 1}: "max" must be a number.`);
  }
  return { ...b, placeholder: false };
}

// → { status: "not-checked" | "pass" | "fail", lines, over, missing }
// A budgeted number that the run doesn't have fails: a missing measurement
// must never pass.
export function compareToBudget(run, budgetFile) {
  if (budgetFile.placeholder) {
    return { status: "not-checked", over: [], missing: [], lines: [`No budgets are set yet${budgetFile.note ? ` (${budgetFile.note})` : ""}. Nothing was checked.`] };
  }
  const runKind = run?.environment?.kind;
  if (runKind !== budgetFile.runKind) {
    throw new BudgetFileError(`These budgets are for ${budgetFile.runKind} runs, and this run is ${runKind || "of an unknown kind"}. Compare like with like.`);
  }
  const over = [];
  const missing = [];
  const lines = [];
  if (budgetFile.basis === "test") lines.push("TEST BUDGET: this only shows the check works. It is not a real budget.");
  for (const b of budgetFile.budgets) {
    const route = (run.routes || []).find((r) => r.key === b.route);
    const value = route ? METRICS[b.metric](route) : undefined;
    if (!Number.isFinite(value)) {
      missing.push(b);
      lines.push(`MISSING ${b.route} ${b.metric}: the run has no number for it (budget ${b.max})`);
    } else if (value > b.max) {
      over.push({ ...b, value });
      lines.push(`OVER    ${b.route} ${b.metric}: ${value} > ${b.max}`);
    } else {
      lines.push(`ok      ${b.route} ${b.metric}: ${value} ≤ ${b.max}`);
    }
  }
  return { status: over.length || missing.length ? "fail" : "pass", over, missing, lines };
}
