// Case studies (Session 48 / MK06). Plain-Node, control-plane backed.
//
// The publication gate IS the feature: a case study publishes only with
// documented merchant consent (consent_ref), a measurement record (period +
// method + results rows), and its limitations/confounders fields present —
// a lift claim without its measurement record and approval CANNOT publish.
// Measured results are kept separate from expectations by the schema: every
// results row is {metric, before, after} and renders under "measured"; the
// narrative body carries no numbers the results table doesn't.
import { platformDb } from "./control.js";
import { slog } from "../log.js";
import { refuse } from "./refuse.js";

const nowIso = () => new Date().toISOString();
const parse = (s, fb) => {
  try {
    return s == null ? fb : JSON.parse(s);
  } catch {
    return fb;
  }
};

export function caseStudyPublishBlocks(row) {
  const blocks = [];
  if (!String(row.consent_ref || "").trim()) blocks.push("merchant consent (consent_ref: who approved, when, how) is required");
  if (!String(row.period || "").trim()) blocks.push("the measurement period is required");
  if (!String(row.method || "").trim()) blocks.push("the measurement method is required");
  const results = Array.isArray(row.results) ? row.results : parse(row.results, []);
  if (!results.length) blocks.push("at least one measured result row is required — no unmeasured lift claims");
  for (const [i, r] of results.entries()) {
    if (!r?.metric || r?.before == null || r?.after == null) blocks.push(`result ${i + 1}: needs metric, before and after`);
  }
  if (!String(row.limitations || "").trim()) blocks.push("state the limitations");
  if (!String(row.confounders || "").trim()) blocks.push("state concurrent changes (confounders) — or write 'none known'");
  return blocks;
}

export async function upsertCaseStudy(input) {
  const slug = String(input.slug || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug)) throw refuse(422, "slug must be lowercase letters/digits/hyphens");
  if (!input.title?.trim()) throw refuse(422, "title required");
  const results = Array.isArray(input.results) ? input.results.slice(0, 10).map((r) => ({ metric: String(r.metric || "").slice(0, 120), before: String(r.before ?? "").slice(0, 60), after: String(r.after ?? "").slice(0, 60) })) : [];
  const row = {
    slug,
    title: input.title.trim().slice(0, 160),
    tenant_id: input.tenant_id || null,
    consent_ref: String(input.consent_ref || "").slice(0, 300),
    period: String(input.period || "").slice(0, 120),
    baseline: String(input.baseline || "").slice(0, 500),
    method: String(input.method || "").slice(0, 500),
    limitations: String(input.limitations || "").slice(0, 500),
    confounders: String(input.confounders || "").slice(0, 500),
    results: JSON.stringify(results),
    quote: String(input.quote || "").slice(0, 500),
    quote_by: String(input.quote_by || "").slice(0, 120),
    body: String(input.body || "").slice(0, 8000),
    published: 0, // publishing is a separate, gated step; an edit unpublishes
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  await platformDb().execute({
    sql: `INSERT INTO case_studies (slug, title, tenant_id, consent_ref, period, baseline, method, limitations, confounders, results, quote, quote_by, body, published, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(slug) DO UPDATE SET title=excluded.title, tenant_id=excluded.tenant_id, consent_ref=excluded.consent_ref,
            period=excluded.period, baseline=excluded.baseline, method=excluded.method, limitations=excluded.limitations,
            confounders=excluded.confounders, results=excluded.results, quote=excluded.quote, quote_by=excluded.quote_by,
            body=excluded.body, published=0, updated_at=excluded.updated_at`,
    args: Object.values(row),
  });
  const saved = await platformDb().execute({ sql: "SELECT * FROM case_studies WHERE slug = ?", args: [slug] });
  return { ...saved.rows[0], results: parse(saved.rows[0].results, []) };
}

export async function setCaseStudyPublished(slug, published) {
  const r = await platformDb().execute({ sql: "SELECT * FROM case_studies WHERE slug = ?", args: [slug] });
  const row = r.rows[0];
  if (!row) throw refuse(422, "case study not found");
  if (published) {
    const blocks = caseStudyPublishBlocks(row);
    if (blocks.length) {
      const err = refuse(422, `can't publish: ${blocks.join(" · ")}`);
      err.blocks = blocks;
      throw err;
    }
  }
  await platformDb().execute({ sql: "UPDATE case_studies SET published = ?, updated_at = ? WHERE slug = ?", args: [published ? 1 : 0, nowIso(), slug] });
  slog("case_study_published", { slug, published: !!published });
  return { slug, published: !!published };
}

export async function listCaseStudies({ publishedOnly = false } = {}) {
  const r = await platformDb().execute(`SELECT * FROM case_studies ${publishedOnly ? "WHERE published = 1" : ""} ORDER BY created_at DESC`);
  return r.rows.map((row) => ({ ...row, published: !!Number(row.published), results: parse(row.results, []), publishBlocks: caseStudyPublishBlocks(row) }));
}

export async function getCaseStudy(slug, { publishedOnly = true } = {}) {
  const r = await platformDb().execute({ sql: "SELECT * FROM case_studies WHERE slug = ?", args: [slug] });
  const row = r.rows[0];
  if (!row) return null;
  if (publishedOnly && !Number(row.published)) return null;
  return { ...row, published: !!Number(row.published), results: parse(row.results, []) };
}

export async function deleteCaseStudy(slug) {
  await platformDb().execute({ sql: "DELETE FROM case_studies WHERE slug = ?", args: [slug] });
  return { slug, deleted: true };
}
