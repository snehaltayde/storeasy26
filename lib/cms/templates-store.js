// Tenant-saved page templates (S54 / audit slice 2). SERVER-ONLY.
// A template stores a VALIDATED section composition for one page family.
// Saving strips instance ids (a template is a pattern, not a page);
// instantiating re-validates and mints FRESH ids, so two pages created from
// one template are fully independent (explicitly "insert a copy" semantics —
// linked shared sections are a later, separate concept).
import { db } from "../db.js";
import { validatePageSections } from "./store.js";
import { ensureSectionIds } from "./registry.js";

const FAMILIES = ["page", "campaign", "journal"];
const nowIso = () => new Date().toISOString();
const tplId = () => "tpl_" + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");

const parse = (s, fallback) => {
  try {
    return JSON.parse(s ?? "");
  } catch {
    return fallback;
  }
};

const stripIds = (sections) => sections.map(({ id, ...rest }) => rest);

export async function listTemplates(family = null) {
  try {
    let q = db.selectFrom("cms_templates").select(["id", "name", "family", "updated_at"]).orderBy("name", "asc");
    if (family && FAMILIES.includes(family)) q = q.where("family", "=", family);
    return (await q.execute()).map((r) => ({ ...r }));
  } catch {
    return []; // pre-migration tenant
  }
}

export async function getTemplate(id) {
  const row = await db.selectFrom("cms_templates").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return null;
  return { id: row.id, name: row.name, family: row.family, sections: parse(row.sections, []), revision: row.revision ?? 1, updated_at: row.updated_at };
}

// A template can hold a section saved under older rules (AU-05 refuses one with
// only empty tags in it). That section goes into the new page as it was, so its
// heading isn't lost, and the page's Save says what to fix. Refusing here would
// lose the whole template, with nothing in the picker to fix it with.
const usableSection = (section) => {
  try {
    return validatePageSections([section]).map(({ id: _id, ...rest }) => rest)[0];
  } catch {
    return section;
  }
};

// Instantiate = validated copy with FRESH instance ids.
export async function instantiateTemplate(id) {
  const tpl = await getTemplate(id);
  if (!tpl) return null;
  return { ...tpl, sections: ensureSectionIds(stripIds(tpl.sections).map(usableSection)) };
}

export async function saveTemplate({ id = null, name, family = "page", sections = [] }) {
  const cleanName = String(name ?? "").trim();
  if (!cleanName) throw new Error("A template needs a name");
  if (cleanName.length > 80) throw new Error(`the template name is too long (${cleanName.length} characters, the limit is 80)`);
  if (!FAMILIES.includes(family)) throw new Error(`family must be ${FAMILIES.join("|")}`);
  // validate THROUGH the real page validator, then strip instance ids
  const validated = stripIds(validatePageSections(sections));
  if (!validated.length) throw new Error("A template needs at least one section");
  const now = nowIso();
  if (id) {
    const res = await db
      .updateTable("cms_templates")
      .set({ name: cleanName, family, sections: JSON.stringify(validated), updated_at: now, revision: (await getTemplate(id))?.revision + 1 || 1 })
      .where("id", "=", id)
      .executeTakeFirst();
    if (Number(res?.numUpdatedRows ?? 0) === 0) throw new Error(`template ${id} not found`);
    return { id, name: cleanName, family };
  }
  const newId = tplId();
  await db
    .insertInto("cms_templates")
    .values({ id: newId, name: cleanName, family, sections: JSON.stringify(validated), version: 1, revision: 1, created_at: now, updated_at: now })
    .execute();
  return { id: newId, name: cleanName, family };
}

export async function deleteTemplate(id) {
  await db.deleteFrom("cms_templates").where("id", "=", id).execute();
}
