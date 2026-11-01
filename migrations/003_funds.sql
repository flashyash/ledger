-- Fund layer: a fund's books are ordinary ledger accounts. These tables only say which account plays which role.

create table funds (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  currency   char(3) not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now()
);

-- Limited partners. Commitments are fixed at creation in v1 (no later closings, transfers or side letters).
create table fund_lps (
  id         uuid primary key default gen_random_uuid(),
  fund_id    uuid not null references funds(id),
  name       text not null,
  commitment bigint not null check (commitment > 0),  -- minor units
  unique (fund_id, name)
);

-- Role of each ledger account in a fund. Fund-level roles have no LP; per-LP roles always do.
create table fund_accounts (
  fund_id    uuid not null references funds(id),
  lp_id      uuid references fund_lps(id),
  kind       text not null check (kind in (
               'cash', 'investments', 'commitments',                                      -- fund-level
               'uncalled', 'receivable', 'contributions', 'distributions', 'fees', 'gains' -- per LP
             )),
  account_id uuid not null unique references accounts(id),
  unique nulls not distinct (fund_id, lp_id, kind),
  check ((lp_id is null) = (kind in ('cash', 'investments', 'commitments')))
);
