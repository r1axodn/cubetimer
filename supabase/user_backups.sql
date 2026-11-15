-- 큐브 타이머 · 클라우드 기록 백업 테이블
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 실행하세요. 여러 번 실행해도 안전합니다.

-- 1) 사용자당 1행인 백업 테이블
create table if not exists public.user_backups (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);

-- 2) RLS 켜기 (본인 행만 접근)
alter table public.user_backups enable row level security;

-- 3) 본인 행만 select / insert / update / delete
drop policy if exists "user_backups_select_own" on public.user_backups;
create policy "user_backups_select_own"
  on public.user_backups for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "user_backups_insert_own" on public.user_backups;
create policy "user_backups_insert_own"
  on public.user_backups for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "user_backups_update_own" on public.user_backups;
create policy "user_backups_update_own"
  on public.user_backups for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "user_backups_delete_own" on public.user_backups;
create policy "user_backups_delete_own"
  on public.user_backups for delete
  to authenticated
  using (auth.uid() = user_id);

-- 4) updated_at 자동 갱신
create or replace function public.touch_user_backups()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_backups_touch on public.user_backups;
create trigger user_backups_touch
  before update on public.user_backups
  for each row execute function public.touch_user_backups();

-- 5) 로그인 사용자 권한
grant select, insert, update, delete on public.user_backups to authenticated;
