-- COM-03: each offer keeps the settings it had before its last change, so the
-- console can offer "Go back to previous offer settings". A JSON snapshot
-- {type, label, starts_at, ends_at, config, replaced_at} written by the same
-- statement that replaces those settings (lib/offers/store.js). NULL until the
-- offer is first changed. Code that runs before this migration saves offers
-- without it (store.js falls back), so the order of deploy and migrate is safe.
-- NOTE: the ALTER is not re-runnable (migrations/README.md rule 3), so it is
-- the only statement in this file.
ALTER TABLE offers ADD COLUMN previous_config TEXT;
