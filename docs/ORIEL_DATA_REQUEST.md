# Data access request — Agamani Basanti Fashions

**To:** Oriel Infonet Solutions support
**From:** Agamani Basanti Fashions Pvt. Ltd. (GSTIN 19AABCO1338F2ZM)
**Re:** Read-only access to our own sales data

---

## What we are doing, and what we are not

We are adding a staff-performance feature to our internal attendance app.
Oriel records every sale correctly; the one thing it cannot tell us is
**which shop assistant made each sale**, because the counter signs in as a
shared till user (`CASH1`). We want to match what our staff record against
the real bills, so the numbers can be trusted.

**We will only ever read. Nothing will be written, changed or deleted in
Oriel, and we are not asking to modify your software in any way.** If any
of this affects your support terms, please say so and we will take the
option that does not.

There are three ways to give us what we need. **Any one of them is
enough.** They are listed easiest-for-you first — please pick whichever
you are most comfortable with.

---

## Option 1 — a nightly emailed report (no database access at all)

Your software advertises *"Email Integration, Schedule Auto Mailing,
Vendor Data & Reports"*. If the **Product-wise** sales report can be
scheduled to email itself every night, that is all we need and you can
ignore the rest of this document.

Please configure it to send daily to: **______________________**
(*we will supply the address*)

The report needs these columns, one row per item per bill:

| Column | Why |
|---|---|
| Bill number | to group lines into a sale |
| Bill date **and time** | to match against when staff recorded it |
| Location / shop code | we have two shops |
| Barcode | this is what our staff scan |
| Item description | for display |
| Quantity | |
| Rate and net amount | |
| Sale or return indicator | so a return is not counted as a sale |
| Cancelled / void flag | so a cancelled bill is not counted |

CSV or Excel, either is fine.

**If the time of the bill cannot be included, please tell us** — it
changes how we match, but is not fatal.

---

## Option 2 — a read-only view (you keep control of the schema)

If you would rather not expose your tables, please create a **database
view** that returns the columns listed in Option 1, plus a second view
for the item master (barcode, item description, MRP / selling price,
category or pattern).

Then create an **Oracle user with SELECT permission on those two views
only** — no other privileges.

This is our preferred option. You decide exactly what is visible, your
internal schema stays private, and if you restructure your tables later
you only have to keep the views working.

Please send:

- Host / IP and port of the database *(our POS server is at 192.168.1.10;
  the Oriel application runs on port 2021 — we do not know the database port)*
- Service name or SID
- The read-only username and password
- The two view names

---

## Option 3 — read-only access to the tables

If Options 1 and 2 are not possible, please send the connection details
above plus a read-only user, and run the four queries in the appendix and
send us the output. Those tell us where the sales data lives so we can
read the right tables and nothing else.

---

## Please answer these regardless of which option you choose

1. **Which Oracle version** are you running?
2. **Do our two shops share one database**, or does each shop have its own?
   If separate, do they replicate to a head office copy?
3. **How does a cancelled bill appear** in the data — is the row deleted,
   or flagged? Which column and value?
4. **How does a sales return appear** — a negative quantity, a separate
   document type, or a flag?
5. **Is a barcode unique to one physical garment**, or shared by every
   piece of the same design and size? *(Our understanding is one code per
   piece — please confirm.)*
6. In the item grid, what does **"Pattern"** mean?
7. Is there a **documented API or web service** we should use instead of
   reading the database?

## Two files, if you can

8. **The item master** exported to Excel — barcode, description, price, category.
9. **One ordinary day's item-wise sales** exported to Excel, showing each
   item on each bill. Any day is fine. Customer names may be blanked out.

---

# Appendix — queries to run and return

These are **read-only catalogue queries**. They return the names and
shapes of tables. They do not read customer or financial data and they
change nothing. Run them in SQL*Plus or SQL Developer and send us the
output as text.

### A1 — version

```sql
select banner from v$version;
```

### A2 — which schema holds the data

```sql
select owner, count(*) as tables
from all_tables
where owner not in ('SYS','SYSTEM','XDB','OUTLN','DBSNMP','APPQOSSYS',
                    'CTXSYS','MDSYS','ORDSYS','WMSYS','LBACSYS','OLAPSYS',
                    'ORDDATA','AUDSYS','OJVMSYS','DVSYS','GSMADMIN_INTERNAL',
                    'DBSFWUSER','REMOTE_SCHEDULER_AGENT')
group by owner
order by 2 desc;
```

### A3 — the sales and item tables

Replace `ORIEL` with the owner name that came back from A2.

```sql
select table_name, num_rows
from all_tables
where owner = 'ORIEL'
  and (  upper(table_name) like '%SAL%'
      or upper(table_name) like '%BILL%'
      or upper(table_name) like '%INVOIC%'
      or upper(table_name) like '%POS%'
      or upper(table_name) like '%COUNTER%'
      or upper(table_name) like '%ITEM%'
      or upper(table_name) like '%BARCOD%'
      or upper(table_name) like '%PROD%'
      or upper(table_name) like '%STOCK%')
order by table_name;
```

> Our counter screen shows `Program ID [COUNTERSALE]`, so a table or
> package with a similar name is probably the right starting point.

### A4 — the columns of those tables

Put the three or four table names from A3 that hold the bill header, the
bill lines and the item master into the list below.

```sql
select table_name, column_id, column_name, data_type, data_length, nullable
from all_tab_columns
where owner = 'ORIEL'
  and table_name in ('PUT_BILL_HEADER_HERE',
                     'PUT_BILL_LINES_HERE',
                     'PUT_ITEM_MASTER_HERE')
order by table_name, column_id;
```

### A5 — a few sample rows (optional but very helpful)

Five rows is plenty. Customer names, phone numbers and GSTINs can be
blanked out — we do not need them.

```sql
select * from ORIEL.PUT_BILL_LINES_HERE
where rownum <= 5;
```

---

**Contact:** please reply to ______________________
We are happy to sign anything you need about not writing to the database.
