-- Ledger v1 schema. `entries` is the source of truth; `balances` is a cache of SUM(entries.amount) per account.

create table accounts (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  currency       char(3) not null check (currency ~ '^[A-Z]{3}$'),
  allow_negative boolean not null default false,  -- true for external/clearing accounts that can go below zero
  created_at     timestamptz not null default now(),
  unique (id, currency)                           -- target for the composite FK on entries
);

create table balances (
  account_id uuid primary key references accounts(id),
  balance    bigint not null default 0,           -- minor units (cents)
  updated_at timestamptz not null default now()
);

create table transactions (
  id           uuid primary key default gen_random_uuid(),
  description  text not null default '',
  effective_at timestamptz not null default now(),  -- when it counts economically
  posted_at    timestamptz not null default now()   -- when we recorded it
);

create table entries (
  id             bigserial primary key,
  transaction_id uuid not null references transactions(id),
  account_id     uuid not null,
  currency       char(3) not null,
  amount         bigint not null check (amount <> 0),  -- signed minor units; never float
  -- An entry's currency must be its account's currency.
  foreign key (account_id, currency) references accounts(id, currency)
);
create index entries_account_idx on entries (account_id, id);
create index entries_transaction_idx on entries (transaction_id);

create table idempotency_keys (
  key            text primary key,
  request_hash   text not null,
  transaction_id uuid references transactions(id),
  created_at     timestamptz not null default now()
);

-- Invariant: every transaction has >= 2 entries and sums to zero per currency.
-- A CHECK can't see other rows, so this is a constraint trigger deferred to COMMIT, when all entries exist.
create function check_transaction_balanced() returns trigger
language plpgsql as $$
declare
  txn uuid;
  n int;
  unbalanced text;
begin
  if tg_table_name = 'entries' then txn := new.transaction_id; else txn := new.id; end if;

  select count(*) into n from entries where transaction_id = txn;
  if n < 2 then
    raise exception 'transaction % has % entries, needs at least 2', txn, n
      using errcode = 'check_violation';
  end if;

  select string_agg(currency || ' ' || total, ', ') into unbalanced
  from (select currency, sum(amount) as total from entries
        where transaction_id = txn group by currency having sum(amount) <> 0) u;
  if unbalanced is not null then
    raise exception 'transaction % does not sum to zero: %', txn, unbalanced
      using errcode = 'check_violation';
  end if;

  return null;
end $$;

-- On transactions too, so a transaction with zero entries can't commit.
create constraint trigger transactions_balanced after insert on transactions
  deferrable initially deferred for each row execute function check_transaction_balanced();
create constraint trigger entries_balanced after insert on entries
  deferrable initially deferred for each row execute function check_transaction_balanced();

-- Invariant: history is append-only. Mistakes are fixed with a reversing transaction, never an edit.
create function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op
    using errcode = 'restrict_violation', hint = 'post a reversing transaction instead';
end $$;

create trigger entries_append_only before update or delete on entries
  for each row execute function forbid_mutation();
create trigger entries_no_truncate before truncate on entries
  for each statement execute function forbid_mutation();
create trigger transactions_append_only before update or delete on transactions
  for each row execute function forbid_mutation();
create trigger transactions_no_truncate before truncate on transactions
  for each statement execute function forbid_mutation();
