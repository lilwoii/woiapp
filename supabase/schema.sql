create table if not exists public.trucks (
  id text primary key,
  name text not null,
  cuisine text not null,
  address text not null,
  latitude double precision not null,
  longitude double precision not null,
  status text not null check (status in ('Open now', 'Moving soon', 'Closed')),
  hours_label text not null,
  next_stop text,
  distance text not null default 'New',
  description text not null,
  cover_note text not null,
  accent text not null default '#C95C31',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.menu_items (
  id text primary key,
  truck_id text not null references public.trucks(id) on delete cascade,
  name text not null,
  price text not null,
  tag text,
  sort_order integer not null default 0
);

create table if not exists public.reviews (
  id text primary key,
  truck_id text not null references public.trucks(id) on delete cascade,
  author text not null default 'Anonymous',
  rating integer not null check (rating between 1 and 5),
  comment text not null,
  created_at timestamptz not null default timezone('utc', now())
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trucks_set_updated_at on public.trucks;
create trigger trucks_set_updated_at
before update on public.trucks
for each row
execute function public.set_updated_at();

alter table public.trucks enable row level security;
alter table public.menu_items enable row level security;
alter table public.reviews enable row level security;

drop policy if exists "public read trucks" on public.trucks;
create policy "public read trucks" on public.trucks for select using (true);
drop policy if exists "public write trucks" on public.trucks;
create policy "public write trucks" on public.trucks for insert with check (true);
drop policy if exists "public update trucks" on public.trucks;
create policy "public update trucks" on public.trucks for update using (true);

drop policy if exists "public read menu" on public.menu_items;
create policy "public read menu" on public.menu_items for select using (true);
drop policy if exists "public write menu" on public.menu_items;
create policy "public write menu" on public.menu_items for insert with check (true);
drop policy if exists "public delete menu" on public.menu_items;
create policy "public delete menu" on public.menu_items for delete using (true);

drop policy if exists "public read reviews" on public.reviews;
create policy "public read reviews" on public.reviews for select using (true);
drop policy if exists "public write reviews" on public.reviews;
create policy "public write reviews" on public.reviews for insert with check (true);
