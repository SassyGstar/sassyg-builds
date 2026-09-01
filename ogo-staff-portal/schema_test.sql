-- ===========================================================================
-- schema_test.sql — proves the database refuses the states the browser
-- currently has to be trusted not to create.
--
-- Run against a database loaded with schema.sql + a seed:
--   psql "$DATABASE_URL" -f schema_test.sql
--
-- Every test runs inside its own transaction and rolls back, so this is safe
-- to run repeatedly and leaves no rows behind. Tests 1-6 must print ERROR;
-- test 7 must print INSERT. Anything else is a regression.
-- ===========================================================================

\set ON_ERROR_STOP off
\set QUIET on

\echo ''
\echo '--- TEST 1: a second pending handoff for a client that already has one'
\echo '---         (expect ERROR: one_pending_handoff_per_client)'
begin;
insert into handoffs (kind, client_id, subject_label, from_employee_id, to_employee_id, status)
select 'client_handoff', h.client_id, 'duplicate',
       (select employee_id from employees where full_name = 'Frances Torres'),
       (select employee_id from employees where full_name = 'Gina Altidor'), 'pending'
from handoffs h where h.status = 'pending' and h.client_id is not null limit 1;
rollback;

\echo ''
\echo '--- TEST 2: handing a client to yourself'
\echo '---         (expect ERROR: no_self_handoff)'
begin;
insert into handoffs (kind, client_id, subject_label, from_employee_id, to_employee_id, status)
select 'client_handoff', c.client_id, c.display_name,
       (select employee_id from employees where full_name = 'Gina Altidor'),
       (select employee_id from employees where full_name = 'Gina Altidor'), 'pending'
from clients c limit 1;
rollback;

\echo ''
\echo '--- TEST 3: settling a handoff without recording when it was settled'
\echo '---         (expect ERROR: response_consistent)'
begin;
update handoffs set status = 'accepted'
where handoff_id = (select handoff_id from handoffs where status = 'pending' limit 1);
rollback;

\echo ''
\echo '--- TEST 4: a second active assignment for one client'
\echo '---         (expect ERROR: one_active_assignment_per_client)'
begin;
insert into client_assignments (client_id, employee_id)
select a.client_id, (select employee_id from employees where full_name = 'Gina Altidor')
from client_assignments a where a.ended_at is null limit 1;
rollback;

\echo ''
\echo '--- TEST 5: a client handoff naming no client'
\echo '---         (expect ERROR: client_handoff_has_client)'
begin;
insert into handoffs (kind, client_id, subject_label, from_employee_id, to_employee_id, status)
values ('client_handoff', null, 'nothing',
        (select employee_id from employees where full_name = 'Gina Altidor'),
        (select employee_id from employees where full_name = 'Vestin Paul'), 'pending');
rollback;

\echo ''
\echo '--- TEST 6: a handoff addressed to nobody at all'
\echo '---         (expect ERROR: directed_or_broadcast)'
begin;
insert into handoffs (kind, subject_label, from_employee_id, status)
values ('alert', 'orphan',
        (select employee_id from employees where full_name = 'Gina Altidor'), 'pending');
rollback;

\echo ''
\echo '--- TEST 7: a legitimate handoff to a different person'
\echo '---         (expect a nonzero count — a false failure here would block real work)'
begin;
insert into handoffs (kind, client_id, subject_label, from_employee_id, to_employee_id, status)
select 'client_handoff', c.client_id, c.display_name,
       (select employee_id from employees where full_name = 'Gina Altidor'),
       (select employee_id from employees where full_name = 'Frances Torres'), 'pending'
from clients c
where c.workflow_status <> 'Closed or Archived'
  and not exists (select 1 from handoffs h
                   where h.client_id = c.client_id and h.status = 'pending')
limit 1;
select count(*) as handoffs_accepted_by_db from handoffs where subject_label <> '' and status = 'pending'
  and from_employee_id = (select employee_id from employees where full_name = 'Gina Altidor');
rollback;

\echo ''
\echo '--- TEST 8: accepting a handoff moves ownership and writes its own audit row'
\echo '---         (expect: old assignment closed, new one opened, audit row present)'
begin;
update handoffs set status = 'accepted', responded_at = now(),
       responded_by = to_employee_id, response_note = 'test'
where handoff_id = (select handoff_id from handoffs
                     where status = 'pending' and kind = 'client_handoff' limit 1);
select count(*) filter (where ended_at is not null) as closed,
       count(*) filter (where ended_at is null)     as open
from client_assignments
where client_id = (select client_id from handoffs where status = 'accepted'
                    order by responded_at desc limit 1);
select action, before_json->>'status' as was, after_json->>'status' as now
from audit_events where entity_type = 'handoff' order by created_at desc limit 1;
rollback;

\echo ''
\echo '--- done'
