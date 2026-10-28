-- Security tests for the Posture.ai schema. Run with: supabase/tests/run.sh
\set ON_ERROR_STOP on
\set QUIET on

create schema test;
grant usage on schema test to anon, authenticated;
create table test.results (name text, ok boolean, detail text);
grant insert, select on test.results to anon, authenticated;

-- Switches the simulated JWT (role is switched separately with SET ROLE).
create function test.login(uid uuid, aal text default 'aal2', email text default null) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'aal', aal, 'email', email, 'role', 'authenticated')::text, false)
$$;
create function test.ok(name text, cond boolean, detail text default null) returns void language sql as $$
  insert into test.results values (name, coalesce(cond, false), detail)
$$;
-- Passes if the statement raises an error.
create function test.fails(name text, stmt text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    perform test.ok(name, true, sqlerrm);
    return;
  end;
  perform test.ok(name, false, 'statement succeeded');
end $$;
create function test.count(stmt text) returns bigint language plpgsql as $$
declare n bigint;
begin execute 'select count(*) from (' || stmt || ') s' into n; return n; end $$;
-- Rows changed by an UPDATE or DELETE.
create function test.affected(stmt text) returns bigint language plpgsql as $$
declare n bigint;
begin execute stmt; get diagnostics n = row_count; return n; end $$;
grant execute on all functions in schema test to anon, authenticated;

insert into auth.users values
  ('00000000-0000-0000-0000-00000000000a', 'alice@acme.test', now()),
  ('00000000-0000-0000-0000-00000000000b', 'bob@other.test', now()),
  ('00000000-0000-0000-0000-00000000000c', 'carol@acme.test', now()),
  ('00000000-0000-0000-0000-00000000000d', 'dave@acme.test', now()),
  ('00000000-0000-0000-0000-00000000000e', 'erin@acme.test', null);

\set alice '\'00000000-0000-0000-0000-00000000000a\''
\set bob '\'00000000-0000-0000-0000-00000000000b\''
\set carol '\'00000000-0000-0000-0000-00000000000c\''
\set dave '\'00000000-0000-0000-0000-00000000000d\''
\set erin '\'00000000-0000-0000-0000-00000000000e\''

-- ---- MFA required ----
select test.login(:alice, 'aal1', 'alice@acme.test');
set role authenticated;
select test.fails('aal1 cannot create an organisation', $$select public.create_organization('Acme')$$);
reset role;

-- ---- Alice creates Acme; Bob creates Other ----
select test.login(:alice, 'aal2', 'alice@acme.test');
set role authenticated;
select public.create_organization('Acme') as acme \gset
select test.ok('creator is owner', (select role from public.my_organizations() where org_id = :'acme') = 'owner');
insert into public.risks (org_id, display_id, data) values (:'acme', 'R-001', '{"title":"VPN"}');
select test.ok('owner can add a risk', test.count($$select 1 from public.risks$$) = 1);
insert into public.vendors (org_id, display_id, data) values (:'acme', 'V-001', '{"name":"NetOps"}');
reset role;

select test.login(:bob, 'aal2', 'bob@other.test');
set role authenticated;
select public.create_organization('Other') as other \gset
select test.ok('tenant isolation: Bob sees no Acme risks', test.count($$select 1 from public.risks$$) = 0);
select test.ok('tenant isolation: Bob sees no Acme vendors', test.count($$select 1 from public.vendors$$) = 0);
select test.ok('tenant isolation: Bob sees only his organisation', test.count($$select 1 from public.organizations$$) = 1);
select test.ok('tenant isolation: Bob sees no Acme memberships', test.count(format($$select 1 from public.memberships where org_id = %L$$, :'acme')) = 0);
select test.fails('tenant isolation: Bob cannot insert into Acme', format($$insert into public.risks (org_id, display_id, data) values (%L, 'R-002', '{}')$$, :'acme'));
select test.ok('tenant isolation: Bob cannot update Acme risks', test.affected(format($$update public.risks set data = '{"title":"pwned"}' where org_id = %L$$, :'acme')) = 0);
select test.ok('tenant isolation: Bob cannot delete Acme risks', test.affected(format($$delete from public.risks where org_id = %L$$, :'acme')) = 0);
select test.fails('tenant isolation: Bob cannot invite into Acme', format($$select public.invite_member(%L, 'x@x.test', 'viewer')$$, :'acme'));
select test.fails('tenant isolation: Bob cannot read Acme quota', format($$select 1/(select count(*) from public.ai_quota(%L))::int$$, :'acme'));
reset role;

-- ---- aal1 session sees nothing even as owner ----
select test.login(:alice, 'aal1', 'alice@acme.test');
set role authenticated;
select test.ok('aal1 owner sees no risks', test.count($$select 1 from public.risks$$) = 0);
select test.fails('aal1 owner cannot insert', format($$insert into public.risks (org_id, display_id, data) values (%L, 'R-009', '{}')$$, :'acme'));
reset role;

-- ---- anonymous has no access ----
select set_config('request.jwt.claims', '{}', false);
set role anon;
select test.fails('anon cannot read risks', $$select * from public.risks$$);
select test.fails('anon cannot call create_organization', $$select public.create_organization('x')$$);
reset role;

-- ---- invitations and roles ----
select test.login(:alice, 'aal2', 'alice@acme.test');
set role authenticated;
select public.invite_member(:'acme', 'Carol@Acme.test', 'analyst');
select public.invite_member(:'acme', 'dave@acme.test', 'viewer');
select public.invite_member(:'acme', 'erin@acme.test', 'viewer');
select test.fails('cannot invite as owner', format($$select public.invite_member(%L, 'z@z.test', 'owner')$$, :'acme'));
reset role;

select test.login(:carol, 'aal1', 'carol@acme.test');
set role authenticated;
select test.fails('accepting invitations requires MFA', $$select public.accept_invitations()$$);
reset role;
select test.login(:carol, 'aal2', 'carol@acme.test');
set role authenticated;
select test.ok('carol accepts invitation', public.accept_invitations() = 1);
select test.ok('carol is analyst', (select role from public.my_organizations() where org_id = :'acme') = 'analyst');
select test.fails('created_by cannot be set by clients', format($$insert into public.risks (org_id, display_id, data, created_by) values (%L, 'R-002', '{}', %L)$$, :'acme', :bob));
insert into public.risks (org_id, display_id, data) values (:'acme', 'R-002', '{"title":"Phishing"}');
select test.ok('created_by is stamped by the server', (select created_by from public.risks where display_id = 'R-002') = :carol::uuid);
update public.risks set data = '{"title":"Phishing v2","owner":"CFO"}' where display_id = 'R-002';
select test.fails('analyst cannot update created_by column', $$update public.risks set created_by = gen_random_uuid()$$);
select test.fails('records cannot move organisation', format($$update public.risks set org_id = %L where display_id = 'R-002'$$, :'other'));
select test.ok('analyst cannot read audit log', test.count($$select 1 from public.audit_log$$) = 0);
select test.ok('analyst cannot see invitations', test.count($$select 1 from public.invitations$$) = 0);
select test.fails('analyst cannot invite', format($$select public.invite_member(%L, 'q@q.test', 'viewer')$$, :'acme'));
select test.fails('analyst cannot change roles', format($$select public.set_member_role(%L, %L, 'admin')$$, :'acme', :carol));
select test.fails('display_id format enforced', format($$insert into public.risks (org_id, display_id, data) values (%L, 'R-1; drop', '{}')$$, :'acme'));
select test.fails('data must be an object', format($$insert into public.risks (org_id, display_id, data) values (%L, 'R-003', '[1,2]')$$, :'acme'));
select test.fails('data size limited', format($$insert into public.risks (org_id, display_id, data) values (%L, 'R-004', jsonb_build_object('x', repeat(md5(random()::text), 5000)))$$, :'acme'));
select test.fails('duplicate display_id rejected', format($$insert into public.risks (org_id, display_id, data) values (%L, 'R-001', '{}')$$, :'acme'));
delete from public.risks where display_id = 'R-002';
select test.ok('analyst can delete', test.count($$select 1 from public.risks where display_id = 'R-002'$$) = 0);
reset role;

select test.login(:dave, 'aal2', 'dave@acme.test');
set role authenticated;
select public.accept_invitations();
select test.ok('viewer can read risks', test.count($$select 1 from public.risks$$) = 1);
select test.fails('viewer cannot insert', format($$insert into public.risks (org_id, display_id, data) values (%L, 'R-005', '{}')$$, :'acme'));
select test.ok('viewer cannot update', test.affected($$update public.risks set data = '{}'$$) = 0);
select test.ok('viewer cannot delete', test.affected($$delete from public.risks$$) = 0);
select test.ok('viewer rename has no effect', test.affected(format($$update public.organizations set name = 'Hacked' where id = %L$$, :'acme')) = 0);
select test.fails('viewer cannot raise AI limit', format($$update public.organizations set ai_monthly_limit = 99999 where id = %L$$, :'acme'));
reset role;

-- ---- saved briefings ----
select test.login(:carol, 'aal2', 'carol@acme.test');
set role authenticated;
select public.save_briefing(:'acme', '{"generatedAt":"2026-10-01T00:00:00Z"}');
select public.save_briefing(:'acme', '{"generatedAt":"2026-10-27T00:00:00Z"}');
select test.ok('analyst can save briefing; new one replaces the old',
  (select array_agg(report ->> 'generatedAt') from public.briefings) = array['2026-10-27T00:00:00Z']);
select test.ok('briefing authorship stamped by the server', (select updated_by from public.briefings) = :carol::uuid);
select test.fails('briefing must be an object', format($$select public.save_briefing(%L, '[1]')$$, :'acme'));
select test.fails('no direct briefing writes', format($$insert into public.briefings (org_id, report) values (%L, '{}')$$, :'acme'));
reset role;

select test.login(:dave, 'aal2', 'dave@acme.test');
set role authenticated;
select test.ok('viewer can read briefing', test.count($$select 1 from public.briefings$$) = 1);
select test.fails('viewer cannot save briefing', format($$select public.save_briefing(%L, '{}')$$, :'acme'));
select test.fails('viewer cannot delete briefing', $$delete from public.briefings$$);
reset role;

select test.login(:bob, 'aal2', 'bob@other.test');
set role authenticated;
select test.ok('tenant isolation: Bob sees no Acme briefing', test.count($$select 1 from public.briefings$$) = 0);
select test.fails('tenant isolation: Bob cannot save Acme briefing', format($$select public.save_briefing(%L, '{}')$$, :'acme'));
reset role;

select test.login(:erin, 'aal2', 'erin@acme.test');
set role authenticated;
select test.ok('unverified email cannot accept invitation', public.accept_invitations() = 0);
reset role;

-- ---- admin rules ----
select test.login(:alice, 'aal2', 'alice@acme.test');
set role authenticated;
select public.set_member_role(:'acme', :carol, 'admin');
reset role;
select test.login(:carol, 'aal2', 'carol@acme.test');
set role authenticated;
select test.ok('admin can read audit log', test.count($$select 1 from public.audit_log$$) > 0);
select test.ok('admin can see invitations', test.count($$select 1 from public.invitations$$) > 0);
select public.invite_member(:'acme', 'frank@acme.test', 'analyst');
select test.fails('admin cannot invite admins', format($$select public.invite_member(%L, 'g@acme.test', 'admin')$$, :'acme'));
select test.fails('admin cannot demote owner', format($$select public.set_member_role(%L, %L, 'viewer')$$, :'acme', :alice));
select test.fails('admin cannot remove owner', format($$select public.remove_member(%L, %L)$$, :'acme', :alice));
select test.fails('admin cannot promote to owner', format($$select public.set_member_role(%L, %L, 'owner')$$, :'acme', :dave));
select public.set_member_role(:'acme', :dave, 'analyst');
select test.ok('admin can promote viewer to analyst', (select role from public.memberships where user_id = :dave::uuid) = 'analyst');
select test.fails('audit log is append-only (update)', $$update public.audit_log set action = 'x'$$);
select test.fails('audit log is append-only (delete)', $$delete from public.audit_log$$);
reset role;

-- ---- owner rules ----
select test.login(:alice, 'aal2', 'alice@acme.test');
set role authenticated;
select test.fails('last owner cannot step down', format($$select public.set_member_role(%L, %L, 'admin')$$, :'acme', :alice));
select test.fails('last owner cannot leave', format($$select public.remove_member(%L, %L)$$, :'acme', :alice));
update public.organizations set name = 'Acme Corp' where id = :'acme';
select test.ok('owner can rename organisation', (select name from public.organizations where id = :'acme') = 'Acme Corp');
select public.remove_member(:'acme', :dave);
select test.ok('owner can remove member', test.count($$select 1 from public.memberships where user_id = '00000000-0000-0000-0000-00000000000d'$$) = 0);
reset role;

-- ---- audit trail contents (checked as superuser) ----
select test.ok('audit records risk insert', exists (select 1 from public.audit_log where entity = 'risks' and action = 'insert' and entity_id = 'R-001'));
select test.ok('audit records changed fields', exists (select 1 from public.audit_log where entity = 'risks' and action = 'update' and details -> 'changed' ? 'owner'));
select test.ok('audit records actor email', exists (select 1 from public.audit_log where actor_email = 'carol@acme.test'));
select test.ok('audit records role change', exists (select 1 from public.audit_log where entity = 'memberships' and action = 'update'));
select test.ok('audit records briefing replacement', exists (select 1 from public.audit_log where entity = 'briefings' and action = 'update'));
select test.ok('audit records member removal', exists (select 1 from public.audit_log where entity = 'memberships' and action = 'delete'));
select test.fails('audit log append-only even for the database owner', $$delete from public.audit_log$$);

\set QUIET off
select case when ok then 'PASS' else 'FAIL' end as result, name, case when not ok then detail end as detail from test.results order by ok, name;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from test.results;
