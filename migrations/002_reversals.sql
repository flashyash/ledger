-- A reversal is an ordinary transaction whose entries negate another's. It points at the original;
-- the original is never touched (history stays append-only).
alter table transactions add column reverses_id uuid references transactions(id);

-- Each transaction can be reversed at most once. Enforced here so two racing reversals can't both commit.
create unique index transactions_reverses_once on transactions (reverses_id) where reverses_id is not null;
