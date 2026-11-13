-- 처리 기록(히스토리) + 활동/오류 로그. Supabase SQL Editor에 통째로 붙여 넣고 Run 하세요.
-- (앱은 이 테이블이 없어도 기존처럼 동작합니다. 테이블을 만들면 기록이 쌓이기 시작합니다.)

-- 1) 처리 기록: 수량이 0이 되어 "다 먹음"/"폐기" 처리된 제품의 사본을 보관. 메인 목록에는 나오지 않고 내 그룹 멤버만 볼 수 있음.
create table if not exists public.item_history (
  id uuid primary key default gen_random_uuid(),
  household text not null,
  item_id text not null unique,                 -- 같은 제품이 두 번 기록되지 않게
  reason text not null,                         -- consumed(다 먹음) | discarded(폐기)
  ended_at timestamptz not null default now(),
  ended_by uuid default auth.uid(),
  data jsonb not null                           -- 처리 당시 제품 정보 전체
);
create index if not exists item_history_hh_idx on public.item_history (household, ended_at desc);
alter table public.item_history enable row level security;
drop policy if exists item_history_select on public.item_history;
create policy item_history_select on public.item_history for select to authenticated using (household = public.my_household());
drop policy if exists item_history_insert on public.item_history;
create policy item_history_insert on public.item_history for insert to authenticated with check (household = public.my_household());
revoke all on public.item_history from anon;   -- 수정/삭제 정책이 없어 기록은 앱에서 바꿀 수 없음

-- 2) 활동/오류 로그: 제품 등록·수정·수량 증감·처리, 로그인, 백업, 오류 등
create table if not exists public.app_logs (
  id bigint generated always as identity primary key,
  household text not null,
  user_id uuid default auth.uid(),
  level text not null default 'info',           -- info | error
  action text not null,
  detail jsonb,
  device text,
  created_at timestamptz not null default now()
);
create index if not exists app_logs_hh_idx on public.app_logs (household, created_at desc);
alter table public.app_logs enable row level security;
drop policy if exists app_logs_select on public.app_logs;
create policy app_logs_select on public.app_logs for select to authenticated using (household = public.my_household());
drop policy if exists app_logs_insert on public.app_logs;
create policy app_logs_insert on public.app_logs for insert to authenticated with check (household = public.my_household());
revoke all on public.app_logs from anon;

-- (선택) 로그는 1년만 보관
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('prune-app-logs', '30 19 * * *', $job$ delete from public.app_logs where created_at < now() - interval '365 days'; $job$);
exception when others then
  raise notice 'pg_cron 설정을 건너뜁니다: %', sqlerrm;
end $$;
