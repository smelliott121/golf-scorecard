-- Schema for Scorecard Live (already applied to the Supabase project in config.js).
-- No sign-in: anyone with a round's code can read and score it.
create table public.courses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  holes jsonb not null,                       -- [{n, par, si}]
  created_at timestamptz not null default now()
);
create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{5,8}$'),
  name text not null default '' check (char_length(name) <= 80),
  course_name text not null check (char_length(course_name) between 1 and 80),
  holes jsonb not null,                       -- snapshot of the course for this round
  created_at timestamptz not null default now()
);
create table public.players (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  handicap integer not null check (handicap between -10 and 54),  -- negative = plus handicap
  grp integer not null default 1 check (grp between 1 and 30),     -- playing group (2-4 balls)
  created_at timestamptz not null default now()
);
create index players_round_idx on public.players(round_id);
create table public.scores (
  player_id uuid not null references public.players(id) on delete cascade,
  round_id uuid not null references public.rounds(id) on delete cascade,
  hole integer not null check (hole between 1 and 18),
  strokes integer not null check (strokes between 1 and 20),
  updated_at timestamptz not null default now(),
  primary key (player_id, hole)
);
create index scores_round_idx on public.scores(round_id);

alter table public.courses enable row level security;
alter table public.rounds  enable row level security;
alter table public.players enable row level security;
alter table public.scores  enable row level security;
create policy "read courses"   on public.courses for select to anon, authenticated using (true);
create policy "add courses"    on public.courses for insert to anon, authenticated with check (true);
create policy "read rounds"    on public.rounds  for select to anon, authenticated using (true);
create policy "add rounds"     on public.rounds  for insert to anon, authenticated with check (true);
create policy "read players"   on public.players for select to anon, authenticated using (true);
create policy "add players"    on public.players for insert to anon, authenticated with check (true);
create policy "edit players"   on public.players for update to anon, authenticated using (true) with check (true);
create policy "remove players" on public.players for delete to anon, authenticated using (true);
create policy "read scores"    on public.scores  for select to anon, authenticated using (true);
create policy "add scores"     on public.scores  for insert to anon, authenticated with check (true);
create policy "edit scores"    on public.scores  for update to anon, authenticated using (true) with check (true);
create policy "remove scores"  on public.scores  for delete to anon, authenticated using (true);

alter table public.scores  replica identity full;
alter table public.players replica identity full;
alter publication supabase_realtime add table public.scores, public.players;
