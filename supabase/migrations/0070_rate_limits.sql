-- Generic fixed-window rate limiter (0068). RUN AGAINST LIVE DB.
create table if not exists public.rate_limits (
  bucket        text        not null,
  window_start  timestamptz not null,
  count         int         not null default 0,
  primary key (bucket, window_start)
);
alter table public.rate_limits enable row level security;
-- No policies: only the SECURITY DEFINER RPC (via service_role) touches it.

create or replace function public.rate_limit_hit(
  p_bucket text, p_limit int, p_window_seconds int
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_window timestamptz :=
    to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count int;
begin
  insert into public.rate_limits (bucket, window_start, count)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start)
    do update set count = public.rate_limits.count + 1
  returning count into v_count;
  return v_count <= p_limit;
end; $$;
revoke all on function public.rate_limit_hit(text,int,int) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text,int,int) to service_role;
