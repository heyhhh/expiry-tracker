-- items에 최초 등록일(created_at, 밀리초) 추가. 이미 적용된 경우 다시 실행해도 안전합니다.
alter table public.items add column if not exists created_at bigint;
update public.items set created_at = updated_at where created_at is null;   -- 기존 제품은 마지막 수정 시각을 등록일로 간주
