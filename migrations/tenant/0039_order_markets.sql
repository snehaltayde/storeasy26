-- Phase 8 line 4: an order placed in a market other than the store's own keeps
-- the money the shopper was charged (subtotal, discount_total, shipping_total,
-- total, currency: the presentment run) plus the base run that goes to Shopify
-- and the reports, and the rate between them. Additive; NULL = a base-market
-- order (every order before this migration), read as COALESCE(base_total, total).
ALTER TABLE orders ADD COLUMN market TEXT;            -- the market's id (its first country code), NULL = base
ALTER TABLE orders ADD COLUMN base_currency TEXT;
ALTER TABLE orders ADD COLUMN fx_rate REAL;           -- base units per 1 market unit at order time
ALTER TABLE orders ADD COLUMN base_subtotal REAL;
ALTER TABLE orders ADD COLUMN base_discount_total REAL;
ALTER TABLE orders ADD COLUMN base_shipping_total REAL;
ALTER TABLE orders ADD COLUMN base_total REAL;
