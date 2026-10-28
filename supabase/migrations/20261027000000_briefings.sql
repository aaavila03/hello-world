-- Latest executive briefing per organisation, kept until the next one replaces it.
-- Everyone in the organisation can read it; analysts and above replace it through
-- public.save_briefing (there are no direct write privileges on the table).

create table public.briefings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references public.organizations (id) on delete cascade,
  report jsonb not null check (jsonb_typeof(report) = 'object' and pg_column_size(report) <= 1048576),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create trigger briefings_stamp before insert or update on public.briefings for each row execute function private.stamp_record();
create trigger briefings_audit after insert or update or delete on public.briefings for each row execute function private.audit_record();

alter table public.briefings enable row level security;
create policy briefing_select on public.briefings for select to authenticated using (private.has_role(org_id, 'viewer'));

revoke all on public.briefings from anon, authenticated;
grant select on public.briefings to authenticated;

-- Replaces the organisation's saved briefing.
create or replace function public.save_briefing(org uuid, briefing jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role(org, 'analyst');
  insert into public.briefings (org_id, report) values (org, briefing)
  on conflict (org_id) do update set report = excluded.report;
end $$;

revoke all on function public.save_briefing(uuid, jsonb) from public, anon;
grant execute on function public.save_briefing(uuid, jsonb) to authenticated;
