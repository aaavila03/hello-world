-- Vendor questionnaire responses and documents, saved online through the
-- vendor's invite link (the intake-ai function writes them with its own
-- database connection). Everyone in the organisation can read them; nobody
-- writes them through the API. One response per vendor, so every link sent to
-- the same vendor opens the same questionnaire.

create table public.intake_responses (
  org_id uuid not null references public.organizations (id) on delete cascade,
  vendor_ref text not null check (vendor_ref ~ '^V-[0-9]{3,6}$'),
  response jsonb not null check (jsonb_typeof(response) = 'object' and pg_column_size(response) <= 2097152),
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  primary key (org_id, vendor_ref)
);

create table public.intake_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  vendor_ref text not null check (vendor_ref ~ '^V-[0-9]{3,6}$'),
  name text not null check (char_length(name) between 1 and 200),
  media_type text not null check (media_type in ('application/pdf', 'text/plain', 'text/markdown', 'text/csv')),
  size integer not null check (size between 1 and 20971520),
  data text not null,
  created_at timestamptz not null default now(),
  unique (org_id, vendor_ref, name)
);
create index intake_documents_vendor_idx on public.intake_documents (org_id, vendor_ref);

alter table public.intake_responses enable row level security;
alter table public.intake_documents enable row level security;
create policy intake_response_select on public.intake_responses for select to authenticated using (private.has_role(org_id, 'viewer'));
create policy intake_document_select on public.intake_documents for select to authenticated using (private.has_role(org_id, 'viewer'));

revoke all on public.intake_responses, public.intake_documents from anon, authenticated;
grant select on public.intake_responses, public.intake_documents to authenticated;
