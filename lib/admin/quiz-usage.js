// Where a product-finder quiz is used, and the catalog tags a quiz can
// point at (Phase 2 line 10, docs/plans/phase-2.md "Line 10"). SERVER-ONLY.
//
// quizUsage() -> Map(slug -> [{ document, name, live, draft }]), one entry
// per page (not archived) that links to /quiz/<slug>:
//   live   its published version links there: document_refs rows
//          (ref_type 'quiz', ref_id the slug; migration 0023, index
//          document_refs_target) joined on documents.published_version_id
//   draft  its working draft links there: the drafts that hold the text
//          "/quiz/" are re-read with refRowsForBody (the same extraction a
//          publish writes), so /quiz/fit never counts for /quiz/fitness
// It fails closed: any read it can't do throws, so a delete never goes
// through on a usage read that did not run. A store without the documents
// tables (before 0021 / 0023) has no page that could use a quiz: empty.
//
// quizTags() -> [{ tag, products, inStock }]: Shopify's raw tags (the ones
// recommendProducts scores on, lowercased), with how many products carry
// each, most used first, then A–Z.
import { libsql } from "../db.js";
import { notMigratedYet } from "../schema-shape.js";
import { refRowsForBody } from "../documents/refs.js";
import { cardRows } from "../catalog/effective.js";

const notThere = (e) => notMigratedYet(e, { table: "document_refs" }) || notMigratedYet(e, { table: "documents" });

export async function quizUsage() {
  const out = new Map();
  const add = (slug, id, label, key) => {
    if (!out.has(slug)) out.set(slug, new Map());
    const pages = out.get(slug);
    const row = pages.get(id) || { document: id, name: label, live: false, draft: false };
    row[key] = true;
    pages.set(id, row);
  };
  let live;
  let drafts;
  try {
    live = await libsql.execute(
      "SELECT DISTINCT r.ref_id AS slug, d.id AS id, d.label AS label FROM document_refs r JOIN documents d ON d.published_version_id = r.version_id " +
        "WHERE r.ref_type = 'quiz' AND d.archived_at IS NULL ORDER BY d.label, d.id",
    );
    drafts = await libsql.execute("SELECT id, label, draft FROM documents WHERE archived_at IS NULL AND instr(draft, '/quiz/') > 0 ORDER BY label, id");
  } catch (e) {
    if (notThere(e)) return out;
    throw e;
  }
  for (const r of live.rows) add(String(r.slug), String(r.id), String(r.label), "live");
  for (const r of drafts.rows) {
    for (const ref of refRowsForBody(String(r.id), "draft", String(r.draft))) if (ref.ref_type === "quiz") add(String(ref.ref_id), String(r.id), String(r.label), "draft");
  }
  return new Map([...out].map(([slug, pages]) => [slug, [...pages.values()]]));
}

// the pages one quiz is used on (see quizUsage)
export async function quizPages(slug) {
  return (await quizUsage()).get(slug) || [];
}

export async function quizTags() {
  const rows = await cardRows({ logic: true });
  const tally = new Map();
  for (const r of rows) {
    for (const t of new Set((r.logic_tags || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))) {
      const c = tally.get(t) || { tag: t, products: 0, inStock: 0 };
      c.products++;
      if (r.available) c.inStock++;
      tally.set(t, c);
    }
  }
  return [...tally.values()].sort((a, b) => b.products - a.products || a.tag.localeCompare(b.tag));
}
