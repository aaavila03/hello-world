-- RiskPilot multi-tenant schema.
--
-- Security model
--   * Every business table carries org_id and is protected by row-level security.
--   * Access requires membership of the organisation AND a session that has passed
--     multi-factor authentication (JWT claim aal = 'aal2').
--   * Roles: owner > admin > analyst > viewer.
--       viewer   read everything in the organisation
--       analyst  + create, edit and delete risks and vendors
--       admin    + manage members and invitations, read the audit log and AI usage
--       owner    + manage admins and owners, rename the organisation
--   * Membership changes go through security-definer functions that enforce the
--     role rules; there are no direct write policies on memberships.
--   * Every change is written to an append-only audit log by triggers.

create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public;

create type public.member_role as enum ('viewer', 'analyst', 'admin', 'owner');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  ai_monthly_limit integer not null default 300 check (ai_monthly_limit between 0 and 100000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

create table public.memberships (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null,
  email text not null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 254),
  role public.member_role not null check (role <> 'owner'),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz
);
create unique index invitations_pending_uniq on public.invitations (org_id, email) where accepted_at is null;

create table public.risks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  display_id text not null check (display_id ~ '^R-[0-9]{3,6}$'),
  data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 65536),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique (org_id, display_id)
);

create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  display_id text not null check (display_id ~ '^V-[0-9]{3,6}$'),
  data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 524288),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique (org_id, display_id)
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  actor uuid,
  actor_email text,
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb,
  at timestamptz not null default now()
);
create index audit_log_org_at_idx on public.audit_log (org_id, at desc);

create table public.ai_usage (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid,
  task text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  at timestamptz not null default now()
);
create index ai_usage_org_at_idx on public.ai_usage (org_id, at desc);

-- ---------------------------------------------------------------------------
-- Helpers (private schema: not exposed through the API)
-- ---------------------------------------------------------------------------

create or replace function private.role_rank(r public.member_role)
returns integer language sql immutable set search_path = '' as $$
  select case r when 'viewer' then 1 when 'analyst' then 2 when 'admin' then 3 when 'owner' then 4 end
$$;

-- True when the session has completed MFA.
create or replace function private.mfa_ok()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;

-- True when the current user is a member of org with at least min_role, on an MFA session.
create or replace function private.has_role(org uuid, min_role public.member_role)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.mfa_ok() and exists (
    select 1 from public.memberships m
    where m.org_id = org and m.user_id = auth.uid()
      and private.role_rank(m.role) >= private.role_rank(min_role)
  )
$$;

create or replace function private.current_role_in(org uuid)
returns public.member_role language sql stable security definer set search_path = '' as $$
  select m.role from public.memberships m where m.org_id = org and m.user_id = auth.uid()
$$;

create or replace function private.require_role(org uuid, min_role public.member_role)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_role(org, min_role) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Audit log: written only by triggers, never updated or deleted
-- ---------------------------------------------------------------------------

create or replace function private.write_audit(org uuid, action text, entity text, entity_id text, details jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_log (org_id, actor, actor_email, action, entity, entity_id, details)
  values (org, auth.uid(), auth.jwt() ->> 'email', action, entity, entity_id, details)
$$;

create or replace function private.audit_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_log is append-only';
end $$;

create trigger audit_log_no_update before update or delete or truncate on public.audit_log
  for each statement execute function private.audit_append_only();

-- Records inserts, updates (with the list of changed fields) and deletes.
create or replace function private.audit_record()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := to_jsonb(coalesce(new, old));
  changed jsonb;
  ident text := coalesce(rec ->> 'display_id', rec ->> 'email', rec ->> 'user_id', rec ->> 'name', rec ->> 'id');
begin
  if tg_op = 'UPDATE' then
    if to_jsonb(new) ? 'data' then
      select coalesce(jsonb_agg(k), '[]'::jsonb) into changed
      from (
        select k from jsonb_object_keys(coalesce(new.data, '{}'::jsonb) || coalesce(old.data, '{}'::jsonb)) k
        where (new.data -> k) is distinct from (old.data -> k)
      ) s;
    else
      select coalesce(jsonb_agg(k), '[]'::jsonb) into changed
      from (
        select k from jsonb_object_keys(to_jsonb(new)) k
        where (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k)
      ) s;
    end if;
  end if;
  perform private.write_audit(
    coalesce((rec ->> 'org_id')::uuid, (rec ->> 'id')::uuid),
    lower(tg_op),
    tg_table_name,
    ident,
    case
      when tg_op = 'UPDATE' then jsonb_build_object('changed', changed)
      when tg_table_name in ('memberships', 'invitations') then jsonb_build_object('role', rec ->> 'role')
      else null
    end
  );
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- Stamps authorship server-side and stops records being moved between organisations.
create or replace function private.stamp_record()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    if new.org_id is distinct from old.org_id or new.id is distinct from old.id then
      raise exception 'records cannot be moved between organisations';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;

create trigger risks_stamp before insert or update on public.risks for each row execute function private.stamp_record();
create trigger vendors_stamp before insert or update on public.vendors for each row execute function private.stamp_record();

create trigger risks_audit after insert or update or delete on public.risks for each row execute function private.audit_record();
create trigger vendors_audit after insert or update or delete on public.vendors for each row execute function private.audit_record();
create trigger memberships_audit after insert or update or delete on public.memberships for each row execute function private.audit_record();
create trigger invitations_audit after insert or update or delete on public.invitations for each row execute function private.audit_record();
create trigger organizations_audit after update on public.organizations for each row execute function private.audit_record();

-- ---------------------------------------------------------------------------
-- Row-level security (the table owner, used by the security-definer functions
-- and triggers below, is exempt; every API role is subject to these policies)
-- ---------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.invitations enable row level security;
alter table public.risks enable row level security;
alter table public.vendors enable row level security;
alter table public.audit_log enable row level security;
alter table public.ai_usage enable row level security;

create policy org_select on public.organizations for select to authenticated
  using (private.has_role(id, 'viewer'));
create policy org_update on public.organizations for update to authenticated
  using (private.has_role(id, 'owner')) with check (private.has_role(id, 'owner'));

create policy membership_select on public.memberships for select to authenticated
  using (private.has_role(org_id, 'viewer'));

create policy invitation_select on public.invitations for select to authenticated
  using (private.has_role(org_id, 'admin'));

create policy risk_select on public.risks for select to authenticated using (private.has_role(org_id, 'viewer'));
create policy risk_insert on public.risks for insert to authenticated with check (private.has_role(org_id, 'analyst'));
create policy risk_update on public.risks for update to authenticated
  using (private.has_role(org_id, 'analyst')) with check (private.has_role(org_id, 'analyst'));
create policy risk_delete on public.risks for delete to authenticated using (private.has_role(org_id, 'analyst'));

create policy vendor_select on public.vendors for select to authenticated using (private.has_role(org_id, 'viewer'));
create policy vendor_insert on public.vendors for insert to authenticated with check (private.has_role(org_id, 'analyst'));
create policy vendor_update on public.vendors for update to authenticated
  using (private.has_role(org_id, 'analyst')) with check (private.has_role(org_id, 'analyst'));
create policy vendor_delete on public.vendors for delete to authenticated using (private.has_role(org_id, 'analyst'));

create policy audit_select on public.audit_log for select to authenticated using (private.has_role(org_id, 'admin'));
create policy ai_usage_select on public.ai_usage for select to authenticated using (private.has_role(org_id, 'admin'));

-- Table privileges: nothing for anonymous users; only what the policies allow for signed-in users.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.organizations, public.memberships, public.invitations, public.audit_log, public.ai_usage to authenticated;
grant update (name) on public.organizations to authenticated;
grant select, delete on public.risks, public.vendors to authenticated;
grant insert (org_id, display_id, data) on public.risks, public.vendors to authenticated;
grant update (data) on public.risks, public.vendors to authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ---------------------------------------------------------------------------
-- API functions (security definer; each checks the caller's role itself)
-- ---------------------------------------------------------------------------

-- Creates an organisation with the caller as its owner.
create or replace function public.create_organization(org_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
  caller_email text := (select u.email from auth.users u where u.id = auth.uid());
begin
  if auth.uid() is null or not private.mfa_ok() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  if (select count(*) from public.memberships m where m.user_id = auth.uid() and m.role = 'owner') >= 5 then
    raise exception 'organisation limit reached';
  end if;
  insert into public.organizations (name, created_by) values (btrim(org_name), auth.uid()) returning id into new_id;
  insert into public.memberships (org_id, user_id, role, email) values (new_id, auth.uid(), 'owner', coalesce(caller_email, ''));
  return new_id;
end $$;

-- Invites someone by email. Admins may invite viewers and analysts; owners may also invite admins.
create or replace function public.invite_member(org uuid, invitee_email text, invitee_role public.member_role)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  inv_id uuid;
  addr text := lower(btrim(invitee_email));
begin
  perform private.require_role(org, 'admin');
  if invitee_role = 'owner' then
    raise exception 'ownership can only be granted to existing members';
  end if;
  if invitee_role = 'admin' and not private.has_role(org, 'owner') then
    raise exception 'only owners can invite admins' using errcode = '42501';
  end if;
  if exists (select 1 from public.memberships m where m.org_id = org and lower(m.email) = addr) then
    raise exception 'already a member';
  end if;
  delete from public.invitations i where i.org_id = org and i.email = addr and i.accepted_at is null;
  insert into public.invitations (org_id, email, role, invited_by) values (org, addr, invitee_role, auth.uid())
  returning id into inv_id;
  return inv_id;
end $$;

create or replace function public.revoke_invitation(invitation uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare org uuid := (select i.org_id from public.invitations i where i.id = invitation);
begin
  perform private.require_role(org, 'admin');
  delete from public.invitations i where i.id = invitation and i.accepted_at is null;
end $$;

-- Joins every organisation that has a pending, unexpired invitation for the caller's verified email.
create or replace function public.accept_invitations()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  addr text;
  n integer := 0;
  inv record;
begin
  if auth.uid() is null or not private.mfa_ok() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  select lower(u.email) into addr from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null;
  if addr is null then return 0; end if;
  for inv in
    select * from public.invitations i where i.email = addr and i.accepted_at is null and i.expires_at > now() for update
  loop
    insert into public.memberships (org_id, user_id, role, email)
    values (inv.org_id, auth.uid(), inv.role, addr)
    on conflict (org_id, user_id) do nothing;
    update public.invitations set accepted_at = now() where id = inv.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Changes a member's role. Admins manage viewers and analysts; owners manage everyone.
-- An organisation always keeps at least one owner.
create or replace function public.set_member_role(org uuid, member uuid, new_role public.member_role)
returns void language plpgsql security definer set search_path = '' as $$
declare
  old_role public.member_role := (select m.role from public.memberships m where m.org_id = org and m.user_id = member);
begin
  perform private.require_role(org, 'admin');
  if old_role is null then raise exception 'not a member'; end if;
  if (old_role in ('admin', 'owner') or new_role in ('admin', 'owner')) and not private.has_role(org, 'owner') then
    raise exception 'only owners can manage admins and owners' using errcode = '42501';
  end if;
  if old_role = 'owner' and new_role <> 'owner'
     and (select count(*) from public.memberships m where m.org_id = org and m.role = 'owner') <= 1 then
    raise exception 'an organisation must keep at least one owner';
  end if;
  update public.memberships set role = new_role where org_id = org and user_id = member;
end $$;

-- Removes a member (or lets a member leave). Same rules as set_member_role.
create or replace function public.remove_member(org uuid, member uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  old_role public.member_role := (select m.role from public.memberships m where m.org_id = org and m.user_id = member);
begin
  if old_role is null then raise exception 'not a member'; end if;
  if member <> auth.uid() then
    perform private.require_role(org, 'admin');
    if old_role in ('admin', 'owner') and not private.has_role(org, 'owner') then
      raise exception 'only owners can remove admins and owners' using errcode = '42501';
    end if;
  elsif not private.mfa_ok() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  if old_role = 'owner' and (select count(*) from public.memberships m where m.org_id = org and m.role = 'owner') <= 1 then
    raise exception 'an organisation must keep at least one owner';
  end if;
  delete from public.memberships where org_id = org and user_id = member;
end $$;

-- The caller's organisations and role (used to pick a workspace after sign-in).
create or replace function public.my_organizations()
returns table (org_id uuid, name text, role public.member_role)
language sql stable security definer set search_path = '' as $$
  select o.id, o.name, m.role
  from public.memberships m join public.organizations o on o.id = m.org_id
  where m.user_id = auth.uid() and private.mfa_ok()
  order by o.name
$$;

-- AI usage this calendar month and the organisation's limit.
create or replace function public.ai_quota(org uuid)
returns table (used integer, monthly_limit integer)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*)::integer from public.ai_usage u where u.org_id = org and u.at >= date_trunc('month', now())),
    (select o.ai_monthly_limit from public.organizations o where o.id = org)
  where private.has_role(org, 'viewer')
$$;

revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema private from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.role_rank(public.member_role), private.mfa_ok(),
  private.has_role(uuid, public.member_role) to authenticated;
grant execute on function public.create_organization(text), public.invite_member(uuid, text, public.member_role),
  public.revoke_invitation(uuid), public.accept_invitations(), public.set_member_role(uuid, uuid, public.member_role),
  public.remove_member(uuid, uuid), public.my_organizations(), public.ai_quota(uuid) to authenticated;
