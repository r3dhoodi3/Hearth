-- One-time promo claim ledger (0071). RUN AGAINST LIVE DB. Requires 0022.
create table if not exists public.promo_claims (
  user_id    uuid not null references auth.users (id) on delete cascade,
  promo_key  text not null,
  claimed_at timestamptz not null default now(),
  ref        text,
  primary key (user_id, promo_key)
);
alter table public.promo_claims enable row level security;
drop policy if exists "promo_claims owner read" on public.promo_claims;
create policy "promo_claims owner read" on public.promo_claims
  for select to authenticated using (user_id = auth.uid());

create or replace function public.claim_promo(p_user uuid, p_key text, p_ref text default null)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into promo_claims (user_id, promo_key, ref)
    values (p_user, p_key, p_ref)
    on conflict (user_id, promo_key) do nothing;
  return found;
end; $$;
revoke all on function public.claim_promo(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_promo(uuid, text, text) to service_role;

create or replace function public.has_claimed_promo(p_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from promo_claims where user_id = auth.uid() and promo_key = p_key);
$$;
revoke all on function public.has_claimed_promo(text) from public, anon;
grant execute on function public.has_claimed_promo(text) to authenticated, service_role;

-- Backfill: every existing pro_ subscriber (any status) has consumed the intro.
insert into public.promo_claims (user_id, promo_key, ref)
select distinct s.user_id, 'pro_intro_monthly', 'backfill:0071'
  from public.subscriptions s
 where s.plan like 'pro\_%' and s.user_id is not null
on conflict (user_id, promo_key) do nothing;
