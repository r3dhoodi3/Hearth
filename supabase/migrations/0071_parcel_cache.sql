-- Parcel lookup cache (0069). RUN AGAINST LIVE DB. Cuts RentCast re-billing.
create table if not exists public.parcel_cache (
  cache_key   text primary key,
  facts       jsonb       not null,
  source      text        not null,
  fetched_at  timestamptz not null default now()
);
alter table public.parcel_cache enable row level security;
-- No policies: read/written only by the admin (service_role) client.
create index if not exists parcel_cache_fetched_at_idx on public.parcel_cache (fetched_at);
