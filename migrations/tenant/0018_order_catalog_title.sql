-- OVL-06: each order line keeps Shopify's own title and the variant's SKU, frozen
-- when the order is placed, next to `title` (what the shopper saw). Once titles
-- can be edited in Storeasy (OVL-01), this is how a founder finds the line in
-- Shopify admin, packing slips and Shopify mail. The order snapshot carries the
-- same two values in its items; it is JSON, so it needs no column.
--
-- Expand only. Nothing is backfilled: old rows keep NULL and show as they always
-- did. lib/orders.js writes these columns only on a tenant that has them
-- (lib/schema-compat.js), so a tenant this has not reached yet keeps taking orders.
--
-- NOTE: neither ALTER is re-runnable (migrations/README.md rule 3). If this file
-- stops between the two, the retry fails with "duplicate column name:
-- catalog_title", and `tenant:migrate -- --check` keeps listing the tenant as
-- missing this migration. Orders keep working there: code needs both columns.
ALTER TABLE order_items ADD COLUMN catalog_title TEXT;
ALTER TABLE order_items ADD COLUMN sku TEXT;
