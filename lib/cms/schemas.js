// Versioned component-schema registry (Session 35 / BE08). Every CMS write
// stamps the schema version that produced it; a future shape change ships as
// version N+1 with a `migrate` hook that upgrades old stored values AT READ
// (storage upgrades lazily — no big-bang data migration). validate.js remains
// the field-level validator; this registry is the typed envelope around it.
//
// Content resolution order (BE08, enforced across lib/cms + lib/brand):
//   1. platform defaults   (lib/cms/defaults.js, lib/content/pages.js, DEFAULT_BRAND)
//   2. theme kit defaults  (S37 — none registered yet)
//   3. tenant tokens       (config.brand → CSS variables)
//   4. page-type template  (S37 / MC09 — not yet)
//   5. tenant content rows (cms_blocks / cms_pages, revision-guarded)
// Later layers win per-field where the getter merges (blocks), per-row where
// it replaces (pages). Equal-priority ambiguity cannot arise: each layer has
// exactly one source per key.
import { validateBlock } from "./validate.js";
import { BLOCK_KEYS } from "./defaults.js";
import { SECTION_ID_RE, legacySectionId } from "./registry.js";

// S54: deterministic id stamp for LAZY READ upgrades — index-derived, never
// random (a random id at read would change the release snapshot hash on
// every request). Valid existing ids are kept.
const stampLegacyIds = (sections) =>
  (Array.isArray(sections) ? sections : []).map((s, i) =>
    s && typeof s === "object" && !(typeof s.id === "string" && SECTION_ID_RE.test(s.id)) ? { ...s, id: legacySectionId(i) } : s,
  );

export const BLOCK_SCHEMAS = Object.fromEntries(
  BLOCK_KEYS.map((key) => [
    key,
    {
      // S54: home_sections v2 = durable section instance ids
      version: key === "home_sections" ? 2 : 1,
      validate: (input) => validateBlock(key, input),
      migrate: (value) => (key === "home_sections" ? stampLegacyIds(value) : value),
    },
  ]),
);

// S38 (SF13): page sections became typed ({kind:"text"|"rich"|"image"}).
// Version 1 rows (no kind) upgrade lazily at read: a bare {heading, body}
// section IS a text section. S54 (v3): sections gain durable instance ids.
export const normalizePageSections = (sections) =>
  stampLegacyIds((Array.isArray(sections) ? sections : []).map((s) => (s && !s.kind ? { kind: "text", ...s } : s)).filter(Boolean));

export const PAGE_SCHEMA = {
  version: 3,
  migrate: (page) => ({ ...page, sections: normalizePageSections(page?.sections) }),
};

// Upgrade a stored value to the current schema (no-op at version 1).
export function upgradeBlock(key, value, storedVersion = 1) {
  const schema = BLOCK_SCHEMAS[key];
  if (!schema || storedVersion >= schema.version) return value;
  return schema.migrate(value, storedVersion);
}
