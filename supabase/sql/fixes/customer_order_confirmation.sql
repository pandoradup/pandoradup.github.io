-- Separate delivery tracking keeps buyer and seller notifications independent.
alter table public.orders add column if not exists notification_sent_at timestamptz;
alter table public.orders add column if not exists customer_confirmation_sent_at timestamptz;
