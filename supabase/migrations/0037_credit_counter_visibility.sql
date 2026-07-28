-- ============================================================
-- 0037: counter staff can see their shop's credit book.
--
-- Until now a worker could read only the sales they personally filed.
-- That was the right call when the app could only CREATE debts — no
-- reason to show one person the whole debtor list.
--
-- Taking payment changes it. A customer comes back on a Tuesday and
-- whoever is on the counter that day has to find their entry; if only
-- the original recorder can see it, the feature works by luck of the
-- roster. So permitted counter staff now see the credit sales of their
-- own shop, and nothing from the other one.
--
-- Still withheld from them: editing, deleting, settling by hand, and
-- any sale from a branch they do not work at. Those remain the owner's.
-- ============================================================

drop policy if exists credit_read on credit_sales;

create policy credit_read on credit_sales for select to authenticated
  using (
    fn_is_staff_admin()
    or recorded_by = auth.uid()
    or exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.active
        and p.can_bill
        and p.branch_id = credit_sales.branch_id
    )
  );

-- Bill photos follow the same rule, otherwise the person taking the
-- money can see the debt but not the bill behind it.
drop policy if exists bills_read on storage.objects;

create policy bills_read on storage.objects for select to authenticated
  using (
    bucket_id = 'bills'
    and (
      fn_is_staff_admin()
      or exists (
        select 1
        from credit_sales c
        join profiles p on p.id = auth.uid()
        where c.bill_path = storage.objects.name
          and (
            c.recorded_by = auth.uid()
            or (p.active and p.can_bill and p.branch_id = c.branch_id)
          )
      )
    )
  );
