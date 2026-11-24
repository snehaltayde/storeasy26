-- Phase 1 line 2 review fix: an operator alert goes out once per signup per
-- failure kind, not on every Try again. Nothing destructive: one added column.

-- The failure kinds already alerted for this signup, as ",kind," entries.
ALTER TABLE signups ADD COLUMN alerted_kinds TEXT;
