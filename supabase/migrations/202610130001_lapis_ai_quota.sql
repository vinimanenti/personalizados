-- One shared budget, weighted by collected orders, across all Edge instances.
create table if not exists public.lapis_ai_quota (
  period text not null check (period in ('day', 'minute')),
  bucket timestamptz not null,
  used integer not null default 0 check (used >= 0),
  primary key (period, bucket)
);
alter table public.lapis_ai_quota enable row level security;
revoke all on table public.lapis_ai_quota from public, anon, authenticated;

create or replace function public.consume_lapis_ai_quota(
  p_orders integer, p_daily_limit integer, p_minute_limit integer
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_now timestamptz;
  v_day timestamptz;
  v_minute timestamptz;
  v_daily_used integer;
  v_minute_used integer;
begin
  if p_orders is null or p_orders < 1 or p_orders > 10
    or p_daily_limit is null or p_daily_limit < 1 or p_daily_limit > 1000000
    or p_minute_limit is null or p_minute_limit < 1 or p_minute_limit > 100000 then
    raise exception 'Invalid quota configuration';
  end if;
  -- All checks and increments are serialized in the same transaction.
  perform pg_advisory_xact_lock(20261013, 1);
  v_now := clock_timestamp();
  v_day := date_trunc('day', v_now at time zone 'UTC') at time zone 'UTC';
  v_minute := date_trunc('minute', v_now at time zone 'UTC') at time zone 'UTC';
  insert into public.lapis_ai_quota(period, bucket, used)
    values ('day', v_day, 0), ('minute', v_minute, 0)
    on conflict (period, bucket) do nothing;
  select used into v_daily_used from public.lapis_ai_quota where period = 'day' and bucket = v_day;
  select used into v_minute_used from public.lapis_ai_quota where period = 'minute' and bucket = v_minute;
  if v_daily_used + p_orders > p_daily_limit or v_minute_used + p_orders > p_minute_limit then
    return false;
  end if;
  update public.lapis_ai_quota set used = used + p_orders
    where (period = 'day' and bucket = v_day) or (period = 'minute' and bucket = v_minute);
  delete from public.lapis_ai_quota where bucket < v_now - interval '2 days';
  return true;
end;
$$;
revoke all on function public.consume_lapis_ai_quota(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_lapis_ai_quota(integer, integer, integer) to service_role;
