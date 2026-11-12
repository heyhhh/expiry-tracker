-- Supabase SQL Editor에서 한 번 실행하세요.
create table if not exists items (
  id          text primary key,
  household   text not null,          -- 가족/기기 공유 코드 (앱 설정에서 입력)
  barcode     text,
  name        text not null,
  brand       text,
  category    text,
  expiry      date not null,
  exp_type    text default '소비기한',
  qty         int  default 1,
  memo        text,
  status      text default 'active',  -- active | done | discarded
  deleted     boolean default false,
  updated_at  bigint not null
);
create index if not exists items_household_idx on items (household);

alter table items enable row level security;
-- MVP: 공유 코드를 아는 사람만 쓰는 방식 (코드는 길고 추측 불가능하게 정하세요).
-- 이후 Supabase Auth 로그인으로 교체 권장.
create policy "mvp_all" on items for all using (true) with check (true);
