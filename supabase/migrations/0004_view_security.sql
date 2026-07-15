-- The advance_balances view was created with default (definer)
-- semantics, meaning it ran with the view owner's privileges and
-- bypassed RLS on advances/advance_repayments — any signed-in user
-- could read everyone's balances. security_invoker makes the view
-- respect the querying user's RLS: workers see their own advances,
-- the owner sees all.
alter view advance_balances set (security_invoker = on);
