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

export const BLOCK_SCHEMAS = Object.fromEntries(
  BLOCK_KEYS.map((key) => [
    key,
    {
      version: 1,
      validate: (input) => validateBlock(key, input),
      // migrate(value, fromVersion) → value — add when version bumps past 1
      migrate: (value) => value,
    },
  ]),
);

// S38 (SF13): page sections became typed ({kind:"text"|"rich"|"image"}).
// Version 1 rows (no kind) upgrade lazily at read: a bare {heading, body}
// section IS a text section.
export const normalizePageSections = (sections) =>
  (Array.isArray(sections) ? sections : []).map((s) => (s && !s.kind ? { kind: "text", ...s } : s)).filter(Boolean);

export const PAGE_SCHEMA = {
  version: 2,
  migrate: (page) => ({ ...page, sections: normalizePageSections(page?.sections) }),
};

// Upgrade a stored value to the current schema (no-op at version 1).
export function upgradeBlock(key, value, storedVersion = 1) {
  const schema = BLOCK_SCHEMAS[key];
  if (!schema || storedVersion >= schema.version) return value;
  return schema.migrate(value, storedVersion);
}
