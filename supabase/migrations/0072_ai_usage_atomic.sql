-- Atomic AI usage counter (0070). RUN AGAINST LIVE DB *before* deploying the
-- code change: the new helper fails CLOSED, so shipping code first darks every
-- AI route. Requires 0024 (ai_usage).
create or replace function public.bump_ai_usage(p_user uuid, p_delta int default 1)
returns int language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  insert into ai_usage (user_id, usage_date, count)
    values (p_user, current_date, greatest(coalesce(p_delta, 1), 0))
    on conflict (user_id, usage_date)
    do update set count = ai_usage.count + greatest(coalesce(p_delta, 1), 0)
    returning count into v_count;
  return v_count;
end; $$;
revoke all on function public.bump_ai_usage(uuid, int) from public;
revoke all on function public.bump_ai_usage(uuid, int) from anon;
revoke all on function public.bump_ai_usage(uuid, int) from authenticated;
grant execute on function public.bump_ai_usage(uuid, int) to service_role;
