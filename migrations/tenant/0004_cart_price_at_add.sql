-- SF06 (Session 32): remember the price a shopper saw when adding a line, so
-- the cart can ACKNOWLEDGE price changes instead of silently repricing.
-- Totals always use the CURRENT catalog price — this column is the reference
-- for the "price changed since you added it" notice only.
-- NOTE: the ALTER is not re-runnable (migrations/README.md rule 3).
ALTER TABLE cart_items ADD COLUMN price_at_add REAL;
