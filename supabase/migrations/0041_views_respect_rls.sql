-- ============================================================
-- 0041: make the credit views obey row level security.
--
-- A Postgres view runs as its OWNER unless told otherwise, so it reads
-- straight past the policies on the tables underneath. customer_balances
-- was therefore a hole in an otherwise careful wall: a counter worker
-- querying it without a branch filter would have been handed every
-- customer of BOTH shops, names and outstanding amounts included — the
-- exact thing credit_read exists to prevent.
--
-- The app happens to filter by branch, but that is the app being polite,
-- not the database being safe. security_invoker makes the view run as
-- whoever queries it, so the same policies apply either way.
-- ============================================================

alter view customer_balances set (security_invoker = on);

-- Same treatment for the per-branch summary added in 0034.
alter view credit_outstanding set (security_invoker = on);
