-- Public plan tiers (owner, 2026-11-26; docs/DECISIONS.md): Launch ₹9,999,
-- Growth ₹24,999, Scale ₹60,000 a month. A fresh database gets these from
-- ensureDefaultPlans (lib/platform/billing.js) as version 1. A database that
-- still SELLS the first default prices (starter ₹999, growth ₹2,999) gets the
-- new price as the next version and the old version retired, which is how a
-- plan changes here: stores already subscribed stay pinned to the version
-- they bought. A plan an operator has already repriced is left alone.
-- Prices are whole paise. `scale` is new and is inserted by ensureDefaultPlans.
INSERT INTO plans (id, version, name, price, currency, interval, features, status, created_at)
SELECT 'starter', (SELECT MAX(version) + 1 FROM plans WHERE id = 'starter'), 'Launch', 999900, 'INR', 'month',
       '{"orders_per_month":1000,"staff_seats":5,"campaigns":true}', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM plans WHERE id = 'starter' AND status = 'active' AND price = 99900);
UPDATE plans SET status = 'retired' WHERE id = 'starter' AND status = 'active' AND price = 99900;

INSERT INTO plans (id, version, name, price, currency, interval, features, status, created_at)
SELECT 'growth', (SELECT MAX(version) + 1 FROM plans WHERE id = 'growth'), 'Growth', 2499900, 'INR', 'month',
       '{"orders_per_month":5000,"staff_seats":15,"campaigns":true}', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM plans WHERE id = 'growth' AND status = 'active' AND price = 299900);
UPDATE plans SET status = 'retired' WHERE id = 'growth' AND status = 'active' AND price = 299900;
