alter table public.incoming_items
  alter column expected_on drop not null,
  add column account text check (account is null or char_length(btrim(account)) between 1 and 200),
  add column created_at timestamptz not null default now();
