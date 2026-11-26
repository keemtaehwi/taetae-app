-- 태태 매장 앱 DB 구조 (Supabase SQL Editor에서 한 번 실행)

-- 1) 직원 프로필
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null default '',
  login_id text,
  role text not null default 'staff' check (role in ('owner','staff')),
  approved boolean not null default false,
  created_at timestamptz not null default now()
);

-- 가입하면 프로필 자동 생성. 첫 가입자는 사장(owner)으로 자동 승인.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare has_owner boolean;
begin
  select exists(select 1 from public.profiles where role = 'owner') into has_owner;
  insert into public.profiles (id, name, login_id, role, approved)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', ''),
    coalesce(new.raw_user_meta_data->>'login_id', split_part(new.email, '@', 1)),
    case when has_owner then 'staff' else 'owner' end,
    not has_owner
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select approved from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'owner' and approved from public.profiles where id = auth.uid()), false)
$$;

-- 2) 재고 품목 (삭제 대신 active=false 로 숨김)
create table if not exists public.items (
  id bigint generated always as identity primary key,
  category text not null default '기타',
  name text not null,
  unit text not null default '개',
  min_qty numeric not null default 0,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 3) 재고조사 기록
create table if not exists public.inventory_counts (
  id bigint generated always as identity primary key,
  item_id bigint not null references public.items(id),
  qty numeric not null,
  counted_by uuid not null default auth.uid() references public.profiles(id),
  counted_at timestamptz not null default now()
);
create index if not exists inventory_counts_item_time on public.inventory_counts(item_id, counted_at desc);

create or replace view public.latest_counts with (security_invoker = on) as
  select distinct on (item_id) item_id, qty, counted_at, counted_by
  from public.inventory_counts order by item_id, counted_at desc;

-- 4) 발주요청
create table if not exists public.orders (
  id bigint generated always as identity primary key,
  item_id bigint references public.items(id),
  item_name text not null,
  qty numeric not null,
  unit text not null default '개',
  note text not null default '',
  status text not null default '요청' check (status in ('요청','주문완료','입고완료','취소')),
  requested_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 5) 출퇴근
create table if not exists public.attendance (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id),
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  note text not null default '',
  edited_by uuid references public.profiles(id),
  edited_at timestamptz
);
create index if not exists attendance_user_time on public.attendance(user_id, clock_in desc);

-- 출근/퇴근은 서버 시간으로만 기록 (직원이 시간 조작 불가)
create or replace function public.clock_in() returns public.attendance
language plpgsql security definer set search_path = public as $$
declare r public.attendance;
begin
  if not public.is_approved() then raise exception '승인되지 않은 계정이에요'; end if;
  if exists(select 1 from public.attendance where user_id = auth.uid() and clock_out is null) then
    raise exception '이미 출근 상태예요. 먼저 퇴근을 눌러 주세요';
  end if;
  insert into public.attendance(user_id) values (auth.uid()) returning * into r;
  return r;
end $$;

create or replace function public.clock_out() returns public.attendance
language plpgsql security definer set search_path = public as $$
declare r public.attendance;
begin
  if not public.is_approved() then raise exception '승인되지 않은 계정이에요'; end if;
  update public.attendance set clock_out = now()
   where id = (select id from public.attendance where user_id = auth.uid() and clock_out is null order by clock_in desc limit 1)
  returning * into r;
  if r.id is null then raise exception '출근 기록이 없어요'; end if;
  return r;
end $$;

-- 6) 보안 규칙 (RLS)
alter table public.profiles enable row level security;
alter table public.items enable row level security;
alter table public.inventory_counts enable row level security;
alter table public.orders enable row level security;
alter table public.attendance enable row level security;

drop policy if exists p_profiles_sel on public.profiles;
create policy p_profiles_sel on public.profiles for select using (id = auth.uid() or public.is_approved());
drop policy if exists p_profiles_upd on public.profiles;
create policy p_profiles_upd on public.profiles for update using (public.is_owner());

drop policy if exists p_items_sel on public.items;
create policy p_items_sel on public.items for select using (public.is_approved());
drop policy if exists p_items_ins on public.items;
create policy p_items_ins on public.items for insert with check (public.is_owner());
drop policy if exists p_items_upd on public.items;
create policy p_items_upd on public.items for update using (public.is_owner());

drop policy if exists p_counts_sel on public.inventory_counts;
create policy p_counts_sel on public.inventory_counts for select using (public.is_approved());
drop policy if exists p_counts_ins on public.inventory_counts;
create policy p_counts_ins on public.inventory_counts for insert with check (public.is_approved() and counted_by = auth.uid());

drop policy if exists p_orders_sel on public.orders;
create policy p_orders_sel on public.orders for select using (public.is_approved());
drop policy if exists p_orders_ins on public.orders;
create policy p_orders_ins on public.orders for insert with check (public.is_approved() and requested_by = auth.uid());
drop policy if exists p_orders_upd on public.orders;
create policy p_orders_upd on public.orders for update using (
  public.is_owner() or (requested_by = auth.uid() and status = '요청')
);

drop policy if exists p_att_sel on public.attendance;
create policy p_att_sel on public.attendance for select using (user_id = auth.uid() or public.is_owner());
drop policy if exists p_att_upd on public.attendance;
create policy p_att_upd on public.attendance for update using (public.is_owner());
drop policy if exists p_att_ins on public.attendance;
create policy p_att_ins on public.attendance for insert with check (public.is_owner());

grant select, insert, update on public.profiles, public.items, public.inventory_counts, public.orders, public.attendance to authenticated;
grant select on public.latest_counts to authenticated;
revoke all on public.profiles, public.items, public.inventory_counts, public.orders, public.attendance, public.latest_counts from anon;
grant execute on function public.clock_in() to authenticated;
grant execute on function public.clock_out() to authenticated;

-- 7) 태태 기본 재고 품목 (앱의 관리 탭에서 추가·수정·숨김 가능)
insert into public.items (category, name, unit, min_qty, sort)
select * from (values
  ('주방 재료','중화면','봉지',5,10),
  ('주방 재료','밀가루','kg',5,11),
  ('주방 재료','전분','kg',3,12),
  ('주방 재료','돼지고기 (탕수육·꿔바로우)','kg',5,13),
  ('주방 재료','오겹살','kg',3,14),
  ('주방 재료','오리고기','kg',2,15),
  ('주방 재료','새우','kg',2,16),
  ('주방 재료','계란','판',2,17),
  ('채소','양파','망',1,20),
  ('채소','대파','단',2,21),
  ('채소','가지','개',10,22),
  ('채소','고추 (피망·청양)','kg',1,23),
  ('채소','양배추','통',2,24),
  ('채소','마늘','kg',1,25),
  ('소스·양념','춘장','통',1,30),
  ('소스·양념','흑초','병',2,31),
  ('소스·양념','굴소스','통',1,32),
  ('소스·양념','간장','통',1,33),
  ('소스·양념','설탕','kg',2,34),
  ('소스·양념','고춧기름','병',1,35),
  ('소스·양념','식용유','통',1,36),
  ('와인','Mucho Más Red 무초마스 레드','병',3,40),
  ('와인','Mucho Más White 무초마스 화이트','병',3,41),
  ('와인','Mucho Más Extra Dry 무초마스 엑스트라 드라이','병',3,42),
  ('와인','뤼 뒤 라부아 카베르네 소비뇽','병',3,43),
  ('와인','보보트 카베르네 메를로','병',3,44),
  ('논알콜 와인','플러스 마이너스 스파클링 NV','병',1,50),
  ('논알콜 와인','플러스 마이너스 화이트 2025','병',1,51),
  ('논알콜 와인','논 1','병',1,52),
  ('논알콜 와인','논 5','병',1,53),
  ('음료','콜라','캔',24,60),
  ('음료','사이다','캔',24,61),
  ('음료','생수','병',20,62),
  ('포장·소모품','포장 용기','개',50,70),
  ('포장·소모품','나무젓가락','개',100,71),
  ('포장·소모품','물티슈','개',100,72),
  ('포장·소모품','비닐봉투','개',50,73),
  ('포장·소모품','키친타월','롤',6,74)
) as v(category, name, unit, min_qty, sort)
where not exists (select 1 from public.items);
