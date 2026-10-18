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

-- v1.3.0: ongoing items, review dates, completion dates, automatic milestone status
alter table public.pm_milestones add column if not exists ongoing boolean not null default false,
  add column if not exists review_date date, add column if not exists completed_on date;
alter table public.pm_tasks add column if not exists ongoing boolean not null default false,
  add column if not exists review_date date, add column if not exists completed_on date;

create or replace function public.pm_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := lower(coalesce(auth.jwt()->>'email', new.updated_by));
  if new.status = 'Complete' then
    if tg_op = 'INSERT' or old.status is distinct from 'Complete' then
      new.completed_on := coalesce(new.completed_on, (now() at time zone 'America/Chicago')::date);
    end if;
    if new.ongoing and new.end_date is null then new.end_date := new.completed_on; end if;
  elsif tg_op = 'UPDATE' and old.status = 'Complete' then
    if new.ongoing and new.end_date is not distinct from old.completed_on then new.end_date := null; end if;
    new.completed_on := null;
  end if;
  return new;
end $$;

create or replace function public.pm_rollup_status(mid uuid)
returns text language sql stable set search_path = public as $$
  select case
    when count(*) = 0 then null
    when bool_and(status = 'Complete') then 'Complete'
    when bool_and(status = 'Not started') then 'Not started'
    when bool_or(status = 'In progress') then 'In progress'
    when bool_or(status = 'Pending') then 'Pending'
    else 'In progress' end
  from public.pm_tasks where milestone_id = mid;
$$;

create or replace function public.pm_task_rollup()
returns trigger language plpgsql security definer set search_path = public as $$
declare mids uuid[]; m uuid; s text;
begin
  if tg_op = 'DELETE' then mids := array[old.milestone_id];
  elsif tg_op = 'UPDATE' then mids := array[new.milestone_id, old.milestone_id];
  else mids := array[new.milestone_id]; end if;
  foreach m in array mids loop
    s := public.pm_rollup_status(m);
    if s is not null then
      update public.pm_milestones set status = s where id = m and status is distinct from s;
    end if;
  end loop;
  return null;
end $$;
create trigger pm_tasks_rollup after insert or delete or update of status, milestone_id on public.pm_tasks
for each row execute function public.pm_task_rollup();

-- v1.4.0: task attachments (Supabase Storage bucket "pm-attachments", private, 50 MB per file)
-- insert into storage.buckets (id, name, public, file_size_limit) values ('pm-attachments','pm-attachments',false,52428800);
-- storage.objects policies: select/insert/update/delete to authenticated where bucket_id = 'pm-attachments' and public.pm_is_member()
create table public.pm_attachments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.pm_tasks(id) on delete cascade,
  file_name text not null,
  storage_path text not null unique,
  size_bytes bigint,
  content_type text,
  uploaded_by text default lower(auth.jwt()->>'email'),
  created_at timestamptz not null default now()
);
alter table public.pm_attachments enable row level security;
create policy pm_attachments_all on public.pm_attachments for all to authenticated
  using (public.pm_is_member()) with check (public.pm_is_member());

-- v1.4.1: pm_touch keeps tasks' % done and status consistent (changed status wins; otherwise
-- 100% -> Complete, 1-99% on a not-started task -> In progress). See migration pm_percent_status_precedence.

-- v1.5.0: phases and key dates
alter table public.pm_milestones add column if not exists phase text,
  add column if not exists key_date boolean not null default false;
alter table public.pm_tasks add column if not exists key_date boolean not null default false;

-- v1.6.1: pm_task_rollup also sets milestone start/end from its tasks (earliest start, latest end;
-- ongoing milestones keep no end). Trigger fires on every task insert/update/delete.

-- v1.7.0: team-code access (requires "Allow anonymous sign-ins" in Supabase Auth settings)
-- pm_settings(key, value) holds join_code; pm_member_key() = email or 'code:<auth uid>';
-- pm_join(code, name) adds the caller to pm_members; pm_get_join_code(); pm_set_join_code(code) (email members only);
-- pm_actor() = email or the code user's name, used for updated_by / activity / uploaded_by.
