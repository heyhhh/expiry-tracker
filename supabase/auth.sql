-- 계정별 리스트(가구) + RLS. Supabase SQL Editor에 통째로 붙여 넣고 Run 하면 됩니다.
-- 이 스크립트는 (1) 리스트/멤버 테이블 생성 (2) 기존 'Master' 데이터를 새 리스트로 옮김 (3) 공개 정책(mvp_all)을 삭제하고 로그인한 멤버만 접근하게 바꿈.

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique,
  created_at timestamptz not null default now()
);
create table if not exists public.members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  joined_at timestamptz not null default now()
);
create index if not exists members_household_idx on public.members(household_id);
alter table public.households enable row level security;
alter table public.members enable row level security;

drop policy if exists members_select_self on public.members;
create policy members_select_self on public.members for select to authenticated using (user_id = auth.uid());
drop policy if exists households_select_member on public.households;
create policy households_select_member on public.households for select to authenticated
  using (id in (select household_id from public.members where user_id = auth.uid()));

create or replace function public.my_household() returns text
language sql stable security definer set search_path = public as
$$ select household_id::text from public.members where user_id = auth.uid() $$;

create or replace function public.my_household_info() returns table(id uuid, name text, invite_code text)
language sql stable security definer set search_path = public as
$$ select h.id, h.name, h.invite_code from public.households h join public.members m on m.household_id = h.id where m.user_id = auth.uid() $$;

create or replace function public.create_household(p_name text) returns table(id uuid, name text, invite_code text)
language plpgsql security definer set search_path = public as $$
declare hid uuid; code text; nm text := left(coalesce(nullif(trim(p_name), ''), '우리 집'), 30);
begin
  if auth.uid() is null then raise exception 'not logged in'; end if;
  if exists (select 1 from members where user_id = auth.uid()) then raise exception 'already in a household'; end if;
  code := upper(left(replace(gen_random_uuid()::text, '-', ''), 12));
  insert into households(name, invite_code) values (nm, code) returning households.id into hid;
  insert into members(user_id, household_id) values (auth.uid(), hid);
  return query select hid, nm, code;
end $$;

create or replace function public.join_household(p_code text) returns table(id uuid, name text, invite_code text)
language plpgsql security definer set search_path = public as $$
declare h households%rowtype;
begin
  if auth.uid() is null then raise exception 'not logged in'; end if;
  if exists (select 1 from members where user_id = auth.uid()) then raise exception 'already in a household'; end if;
  select * into h from households where households.invite_code = upper(trim(p_code));
  if not found then raise exception 'invalid code'; end if;
  insert into members(user_id, household_id) values (auth.uid(), h.id);
  return query select h.id, h.name, h.invite_code;
end $$;

create or replace function public.leave_household() returns void
language sql security definer set search_path = public as
$$ delete from public.members where user_id = auth.uid() $$;

revoke all on function public.my_household(), public.my_household_info(), public.create_household(text), public.join_household(text), public.leave_household() from public, anon;
grant execute on function public.my_household(), public.my_household_info(), public.create_household(text), public.join_household(text), public.leave_household() to authenticated;

-- 기존 데이터(공유 코드 'Master')를 새 리스트로 이전 (초대 코드는 마지막 select로 확인)
do $$
declare hid uuid;
begin
  if exists (select 1 from public.items where household = 'Master') and not exists (select 1 from public.households where name = '기존 리스트') then
    insert into public.households(name, invite_code) values ('기존 리스트', upper(left(replace(gen_random_uuid()::text, '-', ''), 12))) returning id into hid;
    update public.items set household = hid::text where household = 'Master';
  end if;
end $$;

-- items 접근을 "내가 속한 리스트"로 제한 (공개 정책 제거)
drop policy if exists mvp_all on public.items;
drop policy if exists items_member_all on public.items;
create policy items_member_all on public.items for all to authenticated
  using (household = public.my_household())
  with check (household = public.my_household());
revoke all on public.items from anon;

select name as "리스트", invite_code as "초대 코드" from public.households order by created_at;
