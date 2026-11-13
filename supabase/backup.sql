-- 백업 테이블 + (선택) 매일 자동 백업. Supabase SQL Editor에 통째로 붙여 넣고 Run 하세요.
-- 앱도 하루 1번 열 때 자동 백업을 만들기 때문에, 아래 pg_cron 부분이 실패해도 앱 기능은 동작합니다.

create table if not exists public.backups (
  id uuid primary key default gen_random_uuid(),
  household text not null,
  kind text not null default 'auto',          -- auto | manual | pre-restore
  item_count int not null default 0,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists backups_hh_idx on public.backups (household, created_at desc);
alter table public.backups enable row level security;
drop policy if exists backups_member_all on public.backups;
create policy backups_member_all on public.backups for all to authenticated
  using (household = public.my_household())
  with check (household = public.my_household());
revoke all on public.backups from anon;

-- (선택) 앱을 열지 않아도 매일 새벽 4시(한국 시간)에 자동 백업, 자동 백업은 리스트당 최근 150개만 보관
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('daily-items-backup', '0 19 * * *', $job$
    insert into public.backups (household, kind, item_count, data)
      select household, 'auto', count(*), jsonb_agg(to_jsonb(i))
      from public.items i where not deleted group by household;
    delete from public.backups where kind = 'auto' and id in (
      select id from (select id, row_number() over (partition by household order by created_at desc) rn
                      from public.backups where kind = 'auto') t where rn > 150);
  $job$);
exception when others then
  raise notice 'pg_cron을 켤 수 없어 서버 자동 백업은 건너뜁니다 (앱의 하루 1회 자동 백업은 동작): %', sqlerrm;
end $$;
