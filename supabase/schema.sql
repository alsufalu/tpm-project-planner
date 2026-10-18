-- TPM Project Planner schema (already applied to the Supabase project).
-- Kept here for reference / to rebuild in another project.

create table public.pm_members (
  email text primary key check (email = lower(email)),
  display_name text,
  added_by text,
  created_at timestamptz not null default now()
);

create table public.pm_milestones (
  id uuid primary key default gen_random_uuid(),
  position int not null default 0,
  title text not null,
  owner text,
  status text not null default 'Not started' check (status in ('Not started','In progress','Pending','Complete')),
  start_date date,
  end_date date,
  dependencies text,
  comments text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);

create table public.pm_tasks (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references public.pm_milestones(id) on delete cascade,
  position int not null default 0,
  title text not null,
  owner text,
  status text not null default 'Not started' check (status in ('Not started','In progress','Pending','Complete')),
  start_date date,
  end_date date,
  percent_done int not null default 0 check (percent_done between 0 and 100),
  dependencies text,
  comments text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);
create index pm_tasks_milestone_idx on public.pm_tasks(milestone_id);

create table public.pm_activity (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text,
  action text not null,
  entity text not null,
  entity_id uuid,
  milestone_id uuid,
  title text
);
create index pm_activity_at_idx on public.pm_activity(at desc);

create or replace function public.pm_is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.pm_members m where m.email = lower(coalesce(auth.jwt()->>'email','')));
$$;
revoke all on function public.pm_is_member() from public, anon;
grant execute on function public.pm_is_member() to authenticated;

create or replace function public.pm_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := lower(coalesce(auth.jwt()->>'email', new.updated_by));
  return new;
end $$;
create trigger pm_milestones_touch before insert or update on public.pm_milestones for each row execute function public.pm_touch();
create trigger pm_tasks_touch before insert or update on public.pm_tasks for each row execute function public.pm_touch();

create or replace function public.pm_log()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record; ent text; mid uuid;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  ent := case tg_table_name when 'pm_tasks' then 'task' else 'milestone' end;
  if ent = 'task' then mid := (to_jsonb(r)->>'milestone_id')::uuid; else mid := r.id; end if;
  if tg_op = 'DELETE' and ent = 'task' and not exists (select 1 from public.pm_milestones where id = mid) then
    return null;
  end if;
  insert into public.pm_activity(actor, action, entity, entity_id, milestone_id, title)
  values (lower(auth.jwt()->>'email'),
          case tg_op when 'INSERT' then 'added' when 'DELETE' then 'deleted'
            else case when tg_op='UPDATE' and old.status is distinct from new.status then 'set to ' || new.status else 'edited' end end,
          ent, r.id, case when tg_op='DELETE' and ent='milestone' then null else mid end, r.title);
  return null;
end $$;
create trigger pm_milestones_log after insert or update or delete on public.pm_milestones for each row execute function public.pm_log();
create trigger pm_tasks_log after insert or update or delete on public.pm_tasks for each row execute function public.pm_log();
revoke all on function public.pm_log() from public, anon, authenticated;
revoke all on function public.pm_touch() from public, anon, authenticated;

alter table public.pm_members enable row level security;
alter table public.pm_milestones enable row level security;
alter table public.pm_tasks enable row level security;
alter table public.pm_activity enable row level security;

create policy pm_members_all on public.pm_members for all to authenticated using (public.pm_is_member()) with check (public.pm_is_member());
create policy pm_milestones_all on public.pm_milestones for all to authenticated using (public.pm_is_member()) with check (public.pm_is_member());
create policy pm_tasks_all on public.pm_tasks for all to authenticated using (public.pm_is_member()) with check (public.pm_is_member());
create policy pm_activity_select on public.pm_activity for select to authenticated using (public.pm_is_member());

revoke all on public.pm_members, public.pm_milestones, public.pm_tasks, public.pm_activity from anon;

alter publication supabase_realtime add table public.pm_milestones, public.pm_tasks;

-- First member (add others from the Team screen in the app):
-- insert into public.pm_members(email) values ('you@example.com');

-- v1.2.0: priority levels
alter table public.pm_milestones add column if not exists priority text not null default 'Normal' check (priority in ('Critical','High','Normal','Low'));
alter table public.pm_tasks add column if not exists priority text not null default 'Normal' check (priority in ('Critical','High','Normal','Low'));
