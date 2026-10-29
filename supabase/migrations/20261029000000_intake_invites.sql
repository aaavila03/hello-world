-- Vendor invite links. A link to the vendor intake form can carry an invite
-- token so the vendor, who has no account, can ask Claude to fill answers from
-- their own documents. Only a SHA-256 hash of the token is stored. An invite
-- expires after 30 days and allows a few AI runs, which also count against the
-- organisation's monthly AI allowance. The intake-ai function redeems invites
-- with its own database connection; signed-in users can only create them.

create table public.intake_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  vendor_ref text not null default '' check (vendor_ref = '' or vendor_ref ~ '^V-[0-9]{3,6}$'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  ai_uses integer not null default 0 check (ai_uses >= 0),
  ai_limit integer not null default 5 check (ai_limit between 0 and 50)
);
create index intake_invites_org_idx on public.intake_invites (org_id);

alter table public.intake_invites enable row level security;
-- No policies and no privileges for API roles: invites are created through
-- create_intake_invite and read only by the intake-ai function.
revoke all on public.intake_invites from anon, authenticated;

-- Creates an invite for a vendor and returns the token (shown only once).
create or replace function public.create_intake_invite(org uuid, vendor text default '')
returns text language plpgsql security definer set search_path = '' as $$
declare
  token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  perform private.require_role(org, 'analyst');
  insert into public.intake_invites (org_id, vendor_ref, token_hash)
  values (org, coalesce(vendor, ''), encode(sha256(convert_to(token, 'UTF8')), 'hex'));
  perform private.write_audit(org, 'insert', 'intake_invites', nullif(vendor, ''), null);
  return token;
end $$;

revoke all on function public.create_intake_invite(uuid, text) from public, anon;
grant execute on function public.create_intake_invite(uuid, text) to authenticated;
