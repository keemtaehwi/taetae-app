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

-- 7) 태태 재고 품목 82개 (재고조사5.html 기준, 앱 관리 탭에서 추가·수정·숨김 가능)
alter table public.items add column if not exists name_en text not null default '';
alter table public.items add column if not exists regular boolean not null default true;
delete from public.items where not exists (select 1 from public.inventory_counts c where c.item_id=items.id) and not exists (select 1 from public.orders o where o.item_id=items.id);
insert into public.items (category,name,name_en,unit,min_qty,sort,regular) values
('채소','양파','Onion','망',4,1,true),
('채소','쪽파','Scallion','단',3,2,true),
('채소','대파','Green onion','단',5,3,true),
('채소','오이(가시오이)','Cucumber','개',10,4,true),
('채소','알배추','Baby napa cabbage','박스',1,5,true),
('채소','팽이버섯','Skinny mushroom','박스',1,6,true),
('채소','청경채','Green leaves','박스',1,7,true),
('채소','표고버섯','Big mushroom','kg',5,8,true),
('채소','피망 Green','Green pepper','알',5,9,true),
('채소','피망 Red','Red pepper','알',5,10,true),
('채소','피망 Yellow','Yellow pepper','알',5,11,true),
('채소','가지','Eggplant','박스',1,12,true),
('채소','양상추','Iceberg lettuce','알',5,13,true),
('채소','고수','Coriander','단',1,14,true),
('채소','꽈리고추','Wrinkled pepper','kg',1,15,true),
('채소','애호박','Korean zucchini','개',5,16,false),
('채소','무','Radish','박스',1,17,false),
('채소','주키니호박','Zucchini','박스',1,18,false),
('채소','느타리버섯','Oyster mushroom','박스',1,19,false),
('채소','당근','Carrot','개',1,20,false),
('채소','애느타리버섯','Baby oyster mushroom','박스',1,21,false),
('채소','감자','Potato','박스',1,22,false),
('채소','실파(깐실파)','Thin scallion, peeled','단',1,23,false),
('육류','오리 가슴살','Duck breast','kg',5,101,true),
('육류','닭 가슴살','Chicken breast','kg',5,102,true),
('육류','닭 다리살','Chicken thigh','kg',5,103,true),
('육류','탕수육용 등심','Pork loin for tangsuyuk','kg',5,104,true),
('육류','짜장면용 고기','Pork for jjajangmyeon','kg',5,105,true),
('육류','짬뽕용 고기','Pork for jjamppong','kg',5,106,true),
('신선','계란(왕란)','Eggs, jumbo','판',5,201,true),
('신선','생면','Fresh noodles','kg',5,202,true),
('수산','새우 16/20','big shrimp','박스',1,301,true),
('수산','새우 31/40','small shrimp','박스',1,302,true),
('수산','새우 26/30','medium shrimp','kg',5,303,false),
('수산','오징어','Squid','박스',1,304,true),
('가공식품','얇은반달단무지','Pickled radish, half-moon','박스',1,401,true),
('가공식품','배추김치(중국산)','Kimchi, imported','박스',1,402,true),
('가공식품','짜사이','Pickled mustard stem','박스',2,403,true),
('소스/조미료','백설탕','White sugar','포대',1,501,false),
('소스/조미료','중찬명가 볶음춘장 10kg','Black bean paste','박스',1,502,false),
('소스/조미료','롯데 미림(맛술)','Cooking wine','박스',1,503,false),
('소스/조미료','진간장','Soy sauce','박스',1,504,false),
('소스/조미료','미원','MSG','포대',1,505,false),
('소스/조미료','중찬명가 짬뽕다시','Jjamppong seasoning','박스',1,506,false),
('소스/조미료','오뚜기 노두유','Dark soy sauce','박스',1,507,false),
('소스/조미료','이금기 굴소스(파우치)','Oyster sauce','개',2,508,false),
('소스/조미료','치킨스톡(네슬레)','Chicken stock','박스',1,509,false),
('소스/조미료','맛소금','Seasoned salt','박스',1,510,false),
('소스/조미료','쇠고기 다시다(CJ)','Beef seasoning powder','박스',1,511,false),
('소스/조미료','정종(백화수복)','Cooking sake','병',4,512,false),
('소스/조미료','샘표 맛간장','Seasoned soy sauce','박스',1,513,false),
('소스/조미료','오뚜기 양조식초(말통)','Vinegar','개',1,514,false),
('소스/조미료','순후추','Ground pepper','박스',1,515,false),
('소스/조미료','참기름','Sesame oil','개',1,516,false),
('소스/조미료','통깨','Sesame seeds','봉지',3,517,false),
('소스/조미료','이금기 두반장','Doubanjiang','박스',3,518,false),
('소스/조미료','마요네즈(스파우트)','Mayonnaise','박스',1,519,false),
('소스/조미료','칠리오일 Large','Chili oil, large','개',1,520,true),
('소스/조미료','칠리오일 Small 짬뽕용','Chili oil, small - for jjamppong','개',1,521,true),
('식자재','식용유(말통캔)','Cooking oil','캔',2,601,true),
('식자재','감자전분 20kg','Potato starch','포대',1,602,false),
('식자재','새우젓','Salted shrimp','kg',3,603,false),
('식자재','쌀 20kg','Rice','포대',1,604,true),
('음료','스프라이트','Sprite','박스',4,701,true),
('음료','코카콜라 제로','Coke Zero','박스',1,702,true),
('음료','코카콜라','Coca-Cola','박스',1,703,true),
('음료','칠성사이다','Chilsung Cider','박스',1,704,true),
('음료','칠성사이다 제로','Chilsung Cider Zero','박스',1,705,true),
('음료','파인환타','Fanta Pineapple','박스',1,706,false),
('음료','갈아만든배','Pear juice','박스',1,707,false),
('음료','스프라이트 제로','Sprite Zero','박스',1,708,false),
('일회용품','포장용기 105파이 대하','Container 105φ, large base','박스',1,801,false),
('일회용품','포장용기 95파이 소하','Container 95φ, small base','박스',1,802,false),
('일회용품','포장용기 70파이 소하','Container 70φ, small base','박스',1,803,false),
('일회용품','밥용기 Large','Rice container','박스',1,804,true),
('일회용품','밥용기 Small','Rice container','박스',1,805,true),
('일회용품','반찬용기 Small','Side dish container','박스',1,806,true),
('일회용품','배달용 숟가락','Spoons for delivery','박스',1,807,true),
('일회용품','배달용 젓가락','Chopsticks for delivery','박스',1,808,true),
('일회용품','비닐봉투 Small','Plastic bag','묶음',1,809,true),
('일회용품','비닐봉투 Medium','Plastic bag','묶음',1,810,true),
('일회용품','비닐봉투 Large','Plastic bag','묶음',1,811,true);
